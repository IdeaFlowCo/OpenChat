/**
 * Private graph API — the signed-in person's own notes, importance, catch-up
 * cadence and links about the people they know. Every route acts for the
 * authenticated owner only; no id in a request can select another owner.
 * Scope refusals answer 404, never 403: the app signs a person out on 403.
 */
import { Router, type Request, type Response } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import {
  addLink, addNote, createPrivateThing, deleteLink, deleteNote, deletePrivateThing, getNeighbourhood, getPersonOverlay, getThing, getUnlinkedPersonOverlay, listDue, resolvePrivateThing, listOwnerLinks, listThings,
  parseCardPatch, PrivateGraphError, searchPrivate, updateLink, updateNote, updatePersonCard,
} from '../services/privateGraph.js';
import type { Provenance } from '../services/privateGraph.js';

import { captureNoteReview, listNoteReviews, suggestNoteReview, applyNoteReview, undoNoteReview, updatePrivateAsk } from '../services/privateNoteReview.js';

const router = Router();
// The owner's session, or an agent key the owner issued. A key needs `read` to
// look and `write` to change anything; a signed-in person has both.
router.use(resolveActor);
// Requests from the shared Ideaflow connector carry its own scope names.
router.use((req: Request, res: Response, next) => {
  const scopes = req.agentScopes;
  const needed = (getConnectorPrincipal(req) ? 'openchat:' : '') + (req.method === 'GET' ? 'read' : 'write');
  if (scopes && !scopes.includes(needed)) { res.status(404).json({ error: 'Not available to this key' }); return; }
  next();
});

function fail(error: unknown, res: Response): void {
  if (error instanceof PrivateGraphError) { res.status(error.status).json({ ...(error.details ?? {}), error: error.message }); return; }
  console.error('Private graph request failed:', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: 'Could not save that. Try again.' });
}
const owner = (req: Request) => req.user!.userId;
const id = (req: Request, key: string) => req.params[key] as string;

/**
 * Who is writing, from how the request authenticated, never from its body:
 * the owner in the app; an agent through the shared Ideaflow connector (named
 * by the client it registered); or an agent holding one of the owner's
 * OpenChat keys. An agent may mark what it writes as inferred.
 */
export function provenanceFor(req: Request): Provenance {
  const assertion = req.body?.assertion;
  if (assertion !== undefined && assertion !== 'stated' && assertion !== 'inferred') throw new PrivateGraphError(400, 'assertion must be stated or inferred');
  const connector = getConnectorPrincipal(req);
  const agentName = (name: string) => `agent:${name.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Agent'}`;
  if (connector) return { author: agentName(connector.client ?? 'Ideaflow connector'), source: 'connector', assertion: assertion ?? 'stated' };
  if (req.connectorDelegation) return { author: agentName('Ideaflow connector'), source: 'connector', assertion: assertion ?? 'stated' };
  if (req.agentKeyId) return { author: agentName(req.agentKeyLabel ?? 'OpenChat agent key'), source: 'direct-key', assertion: assertion ?? 'stated' };
  return { author: 'owner', source: 'app', assertion: 'stated' };
}

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
  try { res.status(201).json(await addNote(owner(req), { kind: 'user', id: id(req, 'userId') }, req.body?.text, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.post('/people/:userId/links', async (req: Request, res: Response) => {
  try { res.status(201).json(await addLink(owner(req), { kind: 'user', id: id(req, 'userId') }, req.body?.relation, req.body?.to, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.get('/links', async (req: Request, res: Response) => {
  try { res.json(await listOwnerLinks(owner(req), req.query.q)); } catch (error) { fail(error, res); }
});

// Search saved things, people written about, and relations by text, relation type or kind.
router.get('/search', async (req: Request, res: Response) => {
  try { res.json(await searchPrivate(owner(req), { q: req.query.q, relationType: req.query.relationType, kind: req.query.kind, limit: req.query.limit })); } catch (error) { fail(error, res); }
});

// One subject and what is one or two private relations away from it. Never creates anything.
router.get('/neighbourhood', async (req: Request, res: Response) => {
  try {
    const kind = req.query.subjectKind, subjectId = req.query.subjectId;
    if ((kind !== 'user' && kind !== 'thing' && kind !== 'unlinked') || typeof subjectId !== 'string' || !subjectId || subjectId.length > 512) throw new PrivateGraphError(400, 'Choose a subject: subjectKind user, thing or unlinked, and its id');
    res.json(await getNeighbourhood(owner(req), { kind, id: subjectId }, req.query.depth));
  } catch (error) { fail(error, res); }
});

// An Unlinked person as the subject: a published profile id (ref `unlinked:person:<id>`), or one of the owner's imported contacts by connection id or LinkedIn address (ref `linkedin:in:<hash>`).
router.get('/unlinked-people/:profileId', async (req: Request, res: Response) => {
  try { res.json(await getUnlinkedPersonOverlay(owner(req), id(req, 'profileId'))); } catch (error) { fail(error, res); }
});

router.post('/unlinked-people/:profileId/notes', async (req: Request, res: Response) => {
  try { res.status(201).json(await addNote(owner(req), { kind: 'unlinked', id: id(req, 'profileId') }, req.body?.text, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.post('/unlinked-people/:profileId/links', async (req: Request, res: Response) => {
  try { res.status(201).json(await addLink(owner(req), { kind: 'unlinked', id: id(req, 'profileId') }, req.body?.relation, req.body?.to, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.post('/things', async (req: Request, res: Response) => {
  try { res.status(201).json(await createPrivateThing(owner(req), req.body?.kind, req.body?.name)); } catch (error) { fail(error, res); }
});

// Agent path: find or save by name without merging same-named people.
router.post('/things/resolve', async (req: Request, res: Response) => {
  try { res.json(await resolvePrivateThing(owner(req), req.body)); } catch (error) { fail(error, res); }
});

router.get('/things', async (req: Request, res: Response) => {
  try { res.json(await listThings(owner(req), req.query.q, req.query.kind)); } catch (error) { fail(error, res); }
});

router.get('/things/:thingId', async (req: Request, res: Response) => {
  try { res.json(await getThing(owner(req), id(req, 'thingId'))); } catch (error) { fail(error, res); }
});

// Undo for a saved thing: removes it with its notes and links.
router.delete('/things/:thingId', async (req: Request, res: Response) => {
  try { res.json(await deletePrivateThing(owner(req), id(req, 'thingId'))); } catch (error) { fail(error, res); }
});

router.post('/things/:thingId/notes', async (req: Request, res: Response) => {
  try { res.status(201).json(await addNote(owner(req), { kind: 'thing', id: id(req, 'thingId') }, req.body?.text, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.post('/things/:thingId/links', async (req: Request, res: Response) => {
  try { res.status(201).json(await addLink(owner(req), { kind: 'thing', id: id(req, 'thingId') }, req.body?.relation, req.body?.to, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.patch('/notes/:noteId', async (req: Request, res: Response) => {
  try { res.json(await updateNote(owner(req), id(req, 'noteId'), req.body?.text)); } catch (error) { fail(error, res); }
});

router.delete('/notes/:noteId', async (req: Request, res: Response) => {
  try { res.json(await deleteNote(owner(req), id(req, 'noteId'))); } catch (error) { fail(error, res); }
});

// Edit a relation's text in place; merging into an identical existing relation returns it with merged: true.
router.patch('/links/:linkId', async (req: Request, res: Response) => {
  try { res.json(await updateLink(owner(req), id(req, 'linkId'), req.body?.relation, provenanceFor(req))); } catch (error) { fail(error, res); }
});

router.delete('/links/:linkId', async (req: Request, res: Response) => {
  try { res.json(await deleteLink(owner(req), id(req, 'linkId'))); } catch (error) { fail(error, res); }
});

for (const [path, kind, key] of [['people', 'user', 'userId'], ['things', 'thing', 'thingId']] as const) {
  router.post(`/${path}/:${key}/note-reviews`, async (req: Request, res: Response) => {
    try { res.status(201).json(await captureNoteReview(owner(req), { kind, id: id(req, key) }, req.body, provenanceFor(req))); } catch (error) { fail(error, res); }
  });
  router.get(`/${path}/:${key}/note-reviews`, async (req: Request, res: Response) => {
    try { res.json(await listNoteReviews(owner(req), { kind, id: id(req, key) })); } catch (error) { fail(error, res); }
  });
}
router.post('/note-reviews/:reviewId/suggest', async (req: Request, res: Response) => {
  try { res.json(await suggestNoteReview(owner(req), id(req, 'reviewId'))); } catch (error) { fail(error, res); }
});
router.post('/note-reviews/:reviewId/apply', async (req: Request, res: Response) => {
  try { res.json(await applyNoteReview(owner(req), id(req, 'reviewId'), req.body, provenanceFor(req))); } catch (error) { fail(error, res); }
});
router.post('/note-reviews/:reviewId/undo', async (req: Request, res: Response) => {
  try { res.json(await undoNoteReview(owner(req), id(req, 'reviewId'))); } catch (error) { fail(error, res); }
});
router.patch('/asks/:askId', async (req: Request, res: Response) => {
  try { res.json(await updatePrivateAsk(owner(req), id(req, 'askId'), req.body)); } catch (error) { fail(error, res); }
});
export default router;
