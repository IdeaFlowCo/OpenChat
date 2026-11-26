import { Router, type NextFunction, type Request, type Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { broadcastMessageToParticipants } from '../websocket/chatHandler.js';
import { askProfileAgent, getOwnerUsage, isProfileAgentAvailable, ProfileAgentError } from '../services/profileAgent.js';
import {
  AutoResponseError, createRule, deleteRule, discardDraft, listDrafts, listRules, sendDraft, setProfileAgentEnabled, updateRule,
} from '../services/autoResponses.js';

/**
 * Human sessions only: an API key or connector cannot spend someone's agent
 * budget, change rules, or approve drafts on a person's behalf.
 */
const humanOnly = (req: Request, res: Response, next: NextFunction) => {
  if (req.agentKeyId || req.connectorDelegation || getConnectorPrincipal(req) || req.user?.embedded) {
    res.status(403).json({ error: 'A direct signed-in session is required' }); return;
  }
  next();
};
const fail = (res: Response, error: unknown) => {
  if (error instanceof ProfileAgentError) { res.status(error.statusCode).json({ error: error.message, code: error.code }); return; }
  if (error instanceof AutoResponseError) { res.status(error.statusCode).json({ error: error.message }); return; }
  console.warn('[profile-agent] request failed');
  res.status(500).json({ error: 'Request failed' });
};

/** POST /api/chat/agent-reply {messageId, question?} — answer instantly, posted to the chat. */
export const agentReplyRouter = Router();
agentReplyRouter.post('/', requireAuth, humanOnly, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const { messageId, question } = req.body ?? {};
  if (typeof messageId !== 'string' || !messageId) { res.status(400).json({ error: 'messageId is required' }); return; }
  try {
    const posted = await askProfileAgent({
      driver: getDriver(), io: req.app.get('io'), askerId: req.user!.userId, messageId,
      question: typeof question === 'string' && question.trim() ? question : undefined,
      broadcast: broadcastMessageToParticipants,
    });
    res.status(201).json({ message: posted.message });
  } catch (error) { fail(res, error); }
});

/** /api/auto-responses — the owner's agent switch, rules and drafts. */
export const autoResponsesRouter = Router();
autoResponsesRouter.use(requireAuth, humanOnly, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const withSession = (action: (req: Request, session: ReturnType<ReturnType<typeof getDriver>['session']>) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response) => {
    const session = getDriver().session();
    try { const body = await action(req, session); if (body === undefined) res.status(204).send(); else res.status(status).json(body); }
    catch (error) { fail(res, error); }
    finally { await session.close(); }
  };

autoResponsesRouter.get('/settings', withSession(async (req, s) => {
  const usage = await s.executeRead(tx => getOwnerUsage(tx, req.user!.userId));
  return { profileAgentEnabled: usage?.enabled ?? true, available: isProfileAgentAvailable(), spentMicros: usage?.spentMicros ?? 0, capMicros: usage?.capMicros };
}));
autoResponsesRouter.put('/settings', withSession(async (req, s) => {
  const { enabled } = await setProfileAgentEnabled(s, req.user!.userId, req.body?.profileAgentEnabled);
  return { profileAgentEnabled: enabled, available: isProfileAgentAvailable() };
}));
autoResponsesRouter.get('/rules', withSession(async (req, s) => ({ rules: await listRules(s, req.user!.userId) })));
autoResponsesRouter.post('/rules', withSession(async (req, s) => ({ rule: await createRule(s, req.user!.userId, req.body) }), 201));
autoResponsesRouter.patch('/rules/:id', withSession(async (req, s) => ({ rule: await updateRule(s, req.user!.userId, String(req.params.id), req.body) })));
autoResponsesRouter.delete('/rules/:id', withSession(async (req, s) => { await deleteRule(s, req.user!.userId, String(req.params.id)); return undefined; }));
autoResponsesRouter.get('/drafts', withSession(async (req, s) => {
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
  return { drafts: await listDrafts(s, req.user!.userId, conversationId) };
}));
autoResponsesRouter.post('/drafts/:id/discard', withSession(async (req, s) => { await discardDraft(s, req.user!.userId, String(req.params.id)); return undefined; }));
autoResponsesRouter.post('/drafts/:id/send', async (req: Request, res: Response) => {
  try {
    const io = req.app.get('io');
    const message = await sendDraft(getDriver(), req.user!.userId, String(req.params.id), req.body?.text,
      io ? (conversationId, m) => broadcastMessageToParticipants(io, conversationId, m) : undefined);
    res.status(201).json({ message });
  } catch (error) { fail(res, error); }
});
