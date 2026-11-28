import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { requireAuth, requireDirectSession } from '../middleware/auth.js';
import { acquireContextAclLocks } from '../services/contextAccess.js';
import { DirectConversationNotAllowedError, ensureDirectConversation } from '../services/directConversation.js';
import { answerWebsiteQuestion, discoverWebsiteRepresentative, readWebsite, verifyWebsiteBinding, websiteContext } from '../services/websiteRecipient.js';

export interface ReviewedWebsiteSend {
  conversationId: string;
  content: string;
  messageId: string;
  recipientId: string;
  bindingId: string;
}

const reviewSecret = randomBytes(32);
interface Review {
  ownerId: string;
  recipientId: string;
  bindingId: string;
  domain: string;
  content: string;
  messageId: string;
}

export function websiteRecipientRoutes(send: (req: Request, res: Response, reviewed: ReviewedWebsiteSend) => Promise<void>) {
  const router = Router();
  router.use(requireAuth, requireDirectSession, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Rate and concurrency limits cover both outbound HTTPS and model work.
  const limits = new Map<string, { count: number; end: number }>();
  let inFlight = 0;
  async function limited(req: Request, res: Response, action: () => Promise<unknown>) {
    const now = Date.now();
    for (const [id, entry] of limits) if (entry.end <= now) limits.delete(id);
    const id = req.user!.userId;
    const entry = limits.get(id) ?? { count: 0, end: now + 60_000 };
    if (entry.count >= 20 || inFlight >= 16 || (!limits.has(id) && limits.size >= 5000)) {
      res.status(429).json({ error: 'Too many website requests. Try again shortly.' });
      return;
    }
    entry.count++;
    limits.set(id, entry);
    inFlight++;
    try { await action(); }
    catch { if (!res.headersSent) res.status(502).json({ error: 'The website or agent is unavailable. Try again.' }); }
    finally { inFlight--; }
  }

  function draft(req: Request) {
    const context = websiteContext(req.body?.url);
    const question: unknown = req.body?.question;
    return context && typeof question === 'string' && question.trim() && question.length <= 4000
      ? { context, question: question.trim() } : null;
  }

  router.post('/ask', (req, res) => limited(req, res, async () => {
    const question: unknown = req.body?.question;
    const context = websiteContext(req.body?.url);
    const excerpt: unknown = req.body?.excerpt;
    if (typeof question !== 'string' || !question.trim() || question.length > 4000 || (excerpt !== undefined && (typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > 16000))) {
      res.status(400).json({ error: 'Enter a page and a question of up to 4,000 characters.' });
      return;
    }
    const source = typeof excerpt === 'string' ? { text: excerpt.trim() } : context ? await readWebsite(context) : null;
    if (!source) { res.json({ status: 'unreadable' }); return; }
    const answer = await answerWebsiteQuestion(question.trim(), source);
    res.json(answer ? { status: 'answered', ...answer } : { status: 'insufficient' });
  }));

  router.post('/review', (req, res) => limited(req, res, async () => {
    const input = draft(req);
    if (!input) { res.status(400).json({ error: 'Enter a website and a question first.' }); return; }
    const { context, question } = input;
    const ownerId = req.user!.userId;
    const recipient = await discoverWebsiteRepresentative(getDriver(), ownerId, context.domain);
    if (!recipient) { res.json({ status: 'unverified' }); return; }
    const content = `${question}\n\nWebsite context: ${context.domain}${context.path === '/' ? '' : context.path ?? ''}`;
    const review: Review = {
      ownerId, recipientId: recipient.userId, bindingId: recipient.id, domain: recipient.domain,
      content, messageId: `website-${nanoid()}`,
    };
    const token = jwt.sign(review, reviewSecret, { audience: 'website-send', expiresIn: '10m' });
    res.json({ status: 'verified', domain: recipient.domain, name: recipient.name, host: recipient.host, content, token });
  }));

  router.post('/send', (req, res) => limited(req, res, async () => {
    let review: Review;
    try {
      if (req.body?.confirmed !== true || typeof req.body?.token !== 'string' || req.body.token.length > 32_000) throw new Error();
      review = jwt.verify(req.body.token, reviewSecret, { audience: 'website-send', algorithms: ['HS256'] }) as unknown as Review;
      if (review.ownerId !== req.user!.userId) throw new Error();
    } catch { res.status(409).json({ error: 'Review the message and recipient before sending.' }); return; }

    const recipient = await discoverWebsiteRepresentative(getDriver(), review.ownerId, review.domain);
    if (!recipient || recipient.id !== review.bindingId || recipient.userId !== review.recipientId) {
      res.status(409).json({ error: 'The website representative changed or is unavailable. Review again.' });
      return;
    }
    try {
      const io = req.app.get('io') as IOServer | undefined;
      const { conversation } = await ensureDirectConversation(review.ownerId, recipient.userId, io);
      await send(req, res, { conversationId: conversation.id as string, content: review.content, messageId: review.messageId,
        recipientId: review.recipientId, bindingId: review.bindingId });
    } catch (error) {
      if (error instanceof DirectConversationNotAllowedError) {
        res.status(409).json({ error: 'The website representative is unavailable.' });
        return;
      }
      throw error;
    }
  }));

  router.put('/binding', async (req, res) => {
    const binding = verifyWebsiteBinding(req.body?.event);
    if (!binding || binding.userId !== req.user!.userId) {
      res.status(400).json({ error: 'Provide a valid signed binding for your own OpenChat account.' });
      return;
    }
    const session = getDriver().session();
    try {
      const result = await session.executeWrite(async tx => {
        await acquireContextAclLocks(tx, { userIds: [binding.userId] });
        return tx.run(`MATCH (u:User {id:$userId})
          WHERE u.id <> 'assistant'
          OPTIONAL MATCH (u)-[old:REPRESENTS_WEBSITE]->(previous:WebsiteBinding {domain:$domain})
          DELETE old
          WITH DISTINCT u
          MERGE (b:WebsiteBinding {id:$id})
          SET b.domain=$domain
          MERGE (u)-[:REPRESENTS_WEBSITE]->(b)
          RETURN b.id`, binding);
      });
      if (!result.records.length) { res.status(404).json({ error: 'Account unavailable.' }); return; }
      res.json({ domain: binding.domain, pubkey: binding.pubkey });
    } finally { await session.close(); }
  });

  router.delete('/binding/:domain', async (req, res) => {
    const session = getDriver().session();
    try {
      const userId = req.user!.userId;
      await session.executeWrite(async tx => {
        await acquireContextAclLocks(tx, { userIds: [userId] });
        await tx.run(`MATCH (:User {id:$userId})-[r:REPRESENTS_WEBSITE]->(:WebsiteBinding {domain:$domain}) DELETE r`,
          { userId, domain: req.params.domain });
      });
      res.status(204).end();
    } finally { await session.close(); }
  });

  return router;
}
