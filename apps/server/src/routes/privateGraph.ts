/**
 * Private graph API — the signed-in person's own notes, importance, catch-up
 * cadence and links about the people they know. Every route acts for the
 * authenticated owner only; no id in a request can select another owner.
 * Scope refusals answer 404, never 403: the app signs a person out on 403.
 */
import { Router, type Request, type Response } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';
import {
  addLink, addNote, deleteLink, deleteNote, getPersonOverlay, getThing, listDue, listThings,
  parseCardPatch, PrivateGraphError, updateNote, updatePersonCard,
} from '../services/privateGraph.js';

const router = Router();
// The owner's session, or an agent key the owner issued. A key needs `read` to
// look and `write` to change anything; a signed-in person has both.
router.use(resolveActor);
router.use((req: Request, res: Response, next) => {
  const scopes = req.agentScopes;
  const needed = req.method === 'GET' ? 'read' : 'write';
  if (scopes && !scopes.includes(needed)) { res.status(404).json({ error: 'Not available to this key' }); return; }
  next();
});

function fail(error: unknown, res: Response): void {
  if (error instanceof PrivateGraphError) { res.status(error.status).json({ error: error.message }); return; }
  console.error('Private graph request failed:', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: 'Could not save that. Try again.' });
}
const owner = (req: Request) => req.user!.userId;
const id = (req: Request, key: string) => req.params[key] as string;

router.get('/due', async (req: Request, res: Response) => {
  try { res.json(await listDue(owner(req))); } catch (error) { fail(error, res); }
});

router.get('/people/:userId', async (req: Request, res: Response) => {
  try { res.json(await getPersonOverlay(owner(req), id(req, 'userId'))); } catch (error) { fail(error, res); }
});

router.patch('/people/:userId', async (req: Request, res: Response) => {
  try { res.json({ card: await updatePersonCard(owner(req), id(req, 'userId'), parseCardPatch(req.body)) }); } catch (error) { fail(error, res); }
});

router.post('/people/:userId/notes', async (req: Request, res: Response) => {
  try { res.status(201).json(await addNote(owner(req), { kind: 'user', id: id(req, 'userId') }, req.body?.text)); } catch (error) { fail(error, res); }
});

router.post('/people/:userId/links', async (req: Request, res: Response) => {
  try { res.status(201).json(await addLink(owner(req), { kind: 'user', id: id(req, 'userId') }, req.body?.relation, req.body?.to)); } catch (error) { fail(error, res); }
});

router.get('/things', async (req: Request, res: Response) => {
  try { res.json(await listThings(owner(req), req.query.q, req.query.kind)); } catch (error) { fail(error, res); }
});

router.get('/things/:thingId', async (req: Request, res: Response) => {
  try { res.json(await getThing(owner(req), id(req, 'thingId'))); } catch (error) { fail(error, res); }
});

router.post('/things/:thingId/notes', async (req: Request, res: Response) => {
  try { res.status(201).json(await addNote(owner(req), { kind: 'thing', id: id(req, 'thingId') }, req.body?.text)); } catch (error) { fail(error, res); }
});

router.post('/things/:thingId/links', async (req: Request, res: Response) => {
  try { res.status(201).json(await addLink(owner(req), { kind: 'thing', id: id(req, 'thingId') }, req.body?.relation, req.body?.to)); } catch (error) { fail(error, res); }
});

router.patch('/notes/:noteId', async (req: Request, res: Response) => {
  try { res.json(await updateNote(owner(req), id(req, 'noteId'), req.body?.text)); } catch (error) { fail(error, res); }
});

router.delete('/notes/:noteId', async (req: Request, res: Response) => {
  try { res.json(await deleteNote(owner(req), id(req, 'noteId'))); } catch (error) { fail(error, res); }
});

router.delete('/links/:linkId', async (req: Request, res: Response) => {
  try { res.json(await deleteLink(owner(req), id(req, 'linkId'))); } catch (error) { fail(error, res); }
});

export default router;
