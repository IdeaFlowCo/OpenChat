import { Router, type Request, type Response, type NextFunction } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { listAskPublications, readAskPublication } from '../services/askPublications.js';
import { PrivateGraphError } from '../services/privateGraph.js';
const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.headers.authorization !== undefined || getConnectorPrincipal(req) || req.connectorDelegation) {
    await resolveActor(req, res, () => {
      const needed = getConnectorPrincipal(req) ? 'openchat:read' : 'read';
      if (req.agentScopes && !req.agentScopes.includes(needed)) { res.status(404).json({ error: 'Ask unavailable' }); return; }
      next();
    });
  } else next();
});
function route(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { res.json(await fn(req)); }
    catch (error) { if (error instanceof PrivateGraphError) res.status(error.status).json({ error: error.message }); else res.status(503).json({ error: 'Ask publications unavailable' }); }
  };
}
router.get('/ask-publications/shared-with-me', route(req => listAskPublications(req.user?.userId ?? null, { sharedOnly: true, cursor: req.query.cursor, limit: req.query.limit })));
router.get('/ask-publications/:id', route(req => readAskPublication(req.user?.userId ?? null, String(req.params.id))));
router.get('/people/:userId/ask-publications', route(req => listAskPublications(req.user?.userId ?? null, { publisherId: String(req.params.userId), cursor: req.query.cursor, limit: req.query.limit })));
export default router;
