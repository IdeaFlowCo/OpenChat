import { Router } from 'express';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { isContextLaneEnabled } from '../config/features.js';
import { ContextLaneError } from '../services/contextLane.js';
import { listConversationContent, type ContentFilter } from '../services/conversationContent.js';
const router = Router();
router.get('/conversations/:conversationId/content', resolveActor, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isContextLaneEnabled()) { res.status(404).json({ error: 'Context Lane feature is not enabled' }); return; }
  const { filter, search, cursor, limit } = req.query;
  if ([filter, search, cursor, limit].some(value => value !== undefined && typeof value !== 'string') || (limit !== undefined && !/^\d+$/.test(limit as string))) { res.status(400).json({ error: 'Content query values must be single strings; limit must be an integer' }); return; }
  if ((req.agentKeyId && !req.agentScopes?.includes('read')) || (getConnectorPrincipal(req) && !getConnectorPrincipal(req)!.scopes.includes('openchat:read'))) { res.status(403).json({ error: 'Read scope required' }); return; }
  const session = getDriver().session();
  try { res.json(await listConversationContent(session, req.user!.userId, String(req.params.conversationId), { filter: filter as ContentFilter|undefined, search: search as string|undefined, cursor: cursor as string|undefined, limit: limit === undefined ? undefined : Number(limit), includePrivate: !req.agentKeyId && !req.connectorDelegation && !getConnectorPrincipal(req) && !req.user?.embedded }, req.agentKeyId, req.agentScopes)); }
  catch (error) { if (error instanceof ContextLaneError) res.status(error.statusCode).json({ error: error.message }); else { console.warn('[conversation-content] read failed'); res.status(500).json({ error: 'Could not load conversation content' }); } }
  finally { await session.close(); }
});
export default router;
