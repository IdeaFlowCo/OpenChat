/**
 * Imported chat mirrors API (OpenChat-061g) — the signed-in owner's private,
 * read-only copies of chats from other networks. Every route acts for the
 * authenticated owner only; nothing in a request can name another owner.
 * Refusals answer 404, never 403 (the app signs a person out on 403).
 * See docs/imported-chat-mirrors.md.
 */
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { resolveActor } from '../middleware/resolveActor.js';
import {
  deleteImportedChat, getImportedChat, getImportedPerson, importChat, ImportedChatError, listImportedAsks, listImportedChats,
  listImportedMessages, listImportedPeople, setImportedAskStatus,
} from '../services/importedChats.js';

export const IMPORT_PATH = '/api/imported-chats/import';
/**
 * The app-wide JSON parser for every request except the import, whose large
 * body is parsed only after the caller is authenticated (see the route below),
 * so an anonymous request can never make the server buffer 16 MB.
 */
export function exceptImportBody(parser: RequestHandler): RequestHandler {
  return (req, res, next) => (req.method === 'PUT' && req.path === IMPORT_PATH ? next() : parser(req, res, next));
}

const router = Router();
// The owner's session, or an agent key the owner issued: `read` to look,
// `write` to import or change. The shared connector's operations are fixed
// tools that do not include this API; connector, delegated and embedded calls are refused.
router.use(resolveActor);
router.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  if (getConnectorPrincipal(req) || req.connectorDelegation || req.user?.embedded) { res.status(404).json({ error: 'Not available here' }); return; }
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

router.put('/import', express.json({ limit: '16mb' }), async (req: Request, res: Response) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const result = await importChat(owner(req), req.body, { dryRun, importedBy: importedBy(req) });
    res.status(result.created && !dryRun ? 201 : 200).json(result);
  } catch (error) { fail(error, res); }
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

router.get('/:chatId/asks', async (req: Request, res: Response) => {
  try { res.json(await listImportedAsks(owner(req), param(req, 'chatId'))); } catch (error) { fail(error, res); }
});

router.patch('/:chatId/asks/:askId', async (req: Request, res: Response) => {
  try { res.json({ ask: await setImportedAskStatus(owner(req), param(req, 'chatId'), param(req, 'askId'), req.body) }); } catch (error) { fail(error, res); }
});

export default router;
