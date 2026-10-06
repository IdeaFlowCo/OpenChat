import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ensureSharedInbox, resolveUnlinkedRecipient, unlinkedProfileId } from '../services/unlinkedMessaging.js';

const router = Router();
const budgets = new Map<string, { at: number; count: number }>();
router.post('/unlinked/recipient', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const profileId = unlinkedProfileId(req.body?.profile);
  if (!profileId || Object.keys(req.body).some(key => key !== 'profile')) { res.status(400).json({ error: 'A public Unlinked profile is required.' }); return; }
  const now = Date.now();
  for (const [key, value] of budgets) if (now - value.at >= 60000) budgets.delete(key);
  const budget = budgets.get(req.user!.userId) ?? { at: now, count: 0 };
  if (budget.count >= 30 || budgets.size >= 10000 && !budgets.has(req.user!.userId)) { res.status(429).json({ error: 'Please wait a moment and try again.' }); return; }
  budget.count++; budgets.set(req.user!.userId, budget);
  try { res.json(await resolveUnlinkedRecipient(profileId)); }
  catch { res.status(503).json({ error: 'We could not open this person’s inbox. Please try again.' }); }
});
// A confidential exchange: only the authenticated Unlinked server supplies
// the live owner binding. Never accept browser-selected identities.
let sessionWindow = 0, sessionRequests = 0;
router.post('/unlinked/session', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.UNLINKED_MESSAGING_SECRET;
  if (!secret || secret.length < 32 || !process.env.JWT_SECRET) { res.status(503).json({ error: 'messaging_unavailable' }); return; }
  if (req.headers.origin) { res.status(403).json({ error: 'forbidden' }); return; }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${secret}`))) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (Date.now() - sessionWindow >= 60000) { sessionWindow = Date.now(); sessionRequests = 0; }
  if (++sessionRequests > 120) { res.status(429).json({ error: 'rate_limited' }); return; }
  const input = req.body;
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !['issuer', 'subject', 'name'].includes(key)) ||
      input.issuer !== 'https://id.ideaflow.app/api/auth' || typeof input.subject !== 'string' || !input.subject || input.subject.length > 512 ||
      Array.from(input.subject as string).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || typeof input.name !== 'string' || input.name.length > 160) {
    res.status(400).json({ error: 'invalid_identity' }); return;
  }
  try {
    const inbox = await ensureSharedInbox(input, input.name);
    // The placeholder only satisfies the existing JWT envelope. Identity and
    // all account access are by immutable userId; no email is written or linked.
    const user = { userId: inbox.id, name: inbox.name, email: 'shared-inbox@ideaflow.invalid' };
    const token = jwt.sign({ ...user, embedded: 'unlinked' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ token, user });
  } catch { res.status(503).json({ error: 'messaging_unavailable' }); }
});
export default router;
