/**
 * Imported chat mirrors API (OpenChat-061g) — the signed-in owner's private,
 * read-only copies of chats from other networks. Every route acts for the
 * authenticated owner only; nothing in a request can name another owner.
 * Refusals answer 404, never 403 (the app signs a person out on 403).
 * See docs/imported-chat-mirrors.md.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';
import {
  deleteImportedChat, getImportedChat, getImportedPerson, importChat, ImportedChatError, listImportedAsks, listImportedChats,
  listImportedMessages, listImportedPeople, setImportedAskStatus, setParticipantLink,
} from '../services/importedChats.js';

const router = Router();
// The owner's session, or an agent key the owner issued: `read` to look,
// `write` to import or change. The shared connector's operations are fixed
// tools that do not include this API, and a connector-delegated call is refused.
router.use(resolveActor);
router.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.connectorDelegation || req.user?.embedded) { res.status(404).json({ error: 'Not available here' }); return; }
  const scopes = req.agentScopes;
  if (scopes && !scopes.includes(req.method === 'GET' ? 'read' : 'write')) { res.status(404).json({ error: 'Not available to this key' }); return; }
  next();
});

function fail(error: unknown, res: Response): void {
  if (error instanceof ImportedChatError) { res.status(error.status).json({ ...(error.details ?? {}), error: error.message }); return; }
  console.error('Imported chat request failed:', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: 'Could not do that. Try again.' });
}
const owner = (req: Request) => req.user!.userId;
const param = (req: Request, key: string) => req.params[key] as string;
/** Who imported, from how the request authenticated: recorded on the chat for review. */
const importedBy = (req: Request) => req.agentKeyId ? `agent:${(req.agentKeyLabel ?? 'OpenChat agent key').replace(/\s+/g, ' ').trim().slice(0, 80)}` : 'owner';

router.put('/import', async (req: Request, res: Response) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try { res.status(dryRun ? 200 : 201).json(await importChat(owner(req), req.body, { dryRun, importedBy: importedBy(req) })); } catch (error) { fail(error, res); }
});

router.get('/', async (req: Request, res: Response) => {
  try { res.json(await listImportedChats(owner(req))); } catch (error) { fail(error, res); }
});

router.get('/:chatId', async (req: Request, res: Response) => {
  try { res.json(await getImportedChat(owner(req), param(req, 'chatId'))); } catch (error) { fail(error, res); }
});

router.delete('/:chatId', async (req: Request, res: Response) => {
  try { res.json(await deleteImportedChat(owner(req), param(req, 'chatId'))); } catch (error) { fail(error, res); }
});

router.get('/:chatId/messages', async (req: Request, res: Response) => {
  try { res.json(await listImportedMessages(owner(req), param(req, 'chatId'), req.query)); } catch (error) { fail(error, res); }
});

router.get('/:chatId/people', async (req: Request, res: Response) => {
  try { res.json(await listImportedPeople(owner(req), param(req, 'chatId'))); } catch (error) { fail(error, res); }
});

router.get('/:chatId/people/:participantId', async (req: Request, res: Response) => {
  try { res.json(await getImportedPerson(owner(req), param(req, 'chatId'), param(req, 'participantId'))); } catch (error) { fail(error, res); }
});

// Linking a participant to an OpenChat account is the owner's own confirmation, never an agent's.
router.patch('/:chatId/people/:participantId', async (req: Request, res: Response) => {
  if (req.agentKeyId || req.agentScopes) { res.status(404).json({ error: 'Confirm account links in the OpenChat app' }); return; }
  try { res.json({ person: await setParticipantLink(owner(req), param(req, 'chatId'), param(req, 'participantId'), req.body) }); } catch (error) { fail(error, res); }
});

router.get('/:chatId/asks', async (req: Request, res: Response) => {
  try { res.json(await listImportedAsks(owner(req), param(req, 'chatId'))); } catch (error) { fail(error, res); }
});

router.patch('/:chatId/asks/:askId', async (req: Request, res: Response) => {
  try { res.json({ ask: await setImportedAskStatus(owner(req), param(req, 'chatId'), param(req, 'askId'), req.body) }); } catch (error) { fail(error, res); }
});

export default router;
