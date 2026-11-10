/**
 * What was shared into a conversation, and its link resources (OpenChat-c8to).
 *
 *   GET   /api/chat/conversations/:conversationId/sources
 *   GET   /api/chat/conversations/:conversationId/sources/:shareId/messages
 *   GET   /api/chat/conversations/:conversationId/resources
 *   PATCH /api/chat/conversations/:conversationId/resources/:resourceId
 *   PUT   /api/chat/conversations/:conversationId/resources/:resourceId/saved
 *
 * For a member's own signed-in session only. Mirrored messages are somebody's
 * private history that they chose to show these people, so agent keys, the
 * shared connector, delegated and embedded sessions are refused with 404 (the
 * app signs a person out on 403). See docs/shared-chat-mirrors.md.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { listConversationResources, setConversationResourceSaved, updateConversationResource } from '../services/conversationResources.js';
import { ImportedChatError } from '../services/importedChats.js';
import { listConversationSources, listSourceMessages } from '../services/sharedMirrors.js';

/** A person in their own OpenChat session: not an agent key, connector, delegation or embedded session. */
export function directHumanOnly(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  if (req.agentKeyId || req.agentScopes || getConnectorPrincipal(req) || req.connectorDelegation || req.user?.embedded) { res.status(404).json({ error: 'Not available here' }); return; }
  next();
}
const member = [resolveActor, directHumanOnly];

function fail(error: unknown, res: Response): void {
  if (error instanceof ImportedChatError) { res.status(error.status).json({ ...(error.details ?? {}), error: error.message }); return; }
  console.error('Conversation source request failed:', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: 'Could not do that. Try again.' });
}
const me = (req: Request) => req.user!.userId;
const param = (req: Request, key: string) => String(req.params[key]);

const router = Router();

router.get('/conversations/:conversationId/sources', member, async (req: Request, res: Response) => {
  try { res.json(await listConversationSources(me(req), param(req, 'conversationId'))); } catch (error) { fail(error, res); }
});

router.get('/conversations/:conversationId/sources/:shareId/messages', member, async (req: Request, res: Response) => {
  try { res.json(await listSourceMessages(me(req), param(req, 'conversationId'), param(req, 'shareId'), req.query)); } catch (error) { fail(error, res); }
});

router.get('/conversations/:conversationId/resources', member, async (req: Request, res: Response) => {
  try { res.json(await listConversationResources(me(req), param(req, 'conversationId'))); } catch (error) { fail(error, res); }
});

router.patch('/conversations/:conversationId/resources/:resourceId', member, async (req: Request, res: Response) => {
  try { res.json({ resource: await updateConversationResource(me(req), param(req, 'conversationId'), param(req, 'resourceId'), req.body) }); } catch (error) { fail(error, res); }
});

router.put('/conversations/:conversationId/resources/:resourceId/saved', member, async (req: Request, res: Response) => {
  try { res.json({ resource: await setConversationResourceSaved(me(req), param(req, 'conversationId'), param(req, 'resourceId'), req.body) }); } catch (error) { fail(error, res); }
});

export default router;
