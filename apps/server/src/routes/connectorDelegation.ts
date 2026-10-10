import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, requireDirectSession } from '../middleware/auth.js';
import { ConnectorDelegationService, loadConnectorDelegationConfig, type ConnectorScope } from '../services/connectorDelegation.js';

export function createConnectorDelegation() {
  const service = new ConnectorDelegationService(loadConnectorDelegationConfig());
  return { guard: connectorDelegationGuard(service), routes: buildConnectorDelegationRoutes(service) };
}

declare module 'express-serve-static-core' {
  interface Request { connectorDelegation?: { clientId: string; connectorUserId: string; openChatUserId: string; connectorGrantId: string } }
}

export function connectorDelegationGuard(service: ConnectorDelegationService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ocd_')) { next(); return; }
    const token = authorization.slice(7);
    const path = new URL(req.originalUrl, 'http://localhost').pathname;
    const grant = service.authorize(token, req.method, path);
    if (!grant) { res.status(403).json({ error: 'Delegation denied' }); return; }
    req.user = { userId: grant.openChatUserId, email: '' };
    req.connectorDelegation = { clientId: grant.clientId, connectorUserId: grant.connectorUserId,
      openChatUserId: grant.openChatUserId, connectorGrantId: grant.connectorGrantId };
    req.agentScopes = grant.scopes;
    next();
  };
}

function clientId(req: Request, service: ConnectorDelegationService): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return null;
  let decoded: string;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const colon = decoded.indexOf(':');
  if (colon < 1) return null;
  const id = decoded.slice(0, colon);
  return service.authenticateClient(id, decoded.slice(colon + 1)) ? id : null;
}

function objectBody(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input));
}

export function buildConnectorDelegationRoutes(service: ConnectorDelegationService): Router {
  const router = Router();
  router.use((_req, res, next) => { if (!service.enabled) { res.sendStatus(404); return; } next(); });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  router.post('/start', (req, res) => {
    const id = clientId(req, service);
    if (!id || !objectBody(req.body)) { res.sendStatus(401); return; }
    const tx = service.start({
      clientId: id,
      callback: req.body.callback as string,
      connectorGrantId: req.body.connectorGrantId as string,
      connectorUserId: req.body.connectorUserId as string,
      scopes: req.body.scopes as unknown as ConnectorScope[],
      state: req.body.state as string,
      codeChallenge: req.body.codeChallenge as string,
      expectedOpenChatUserId: req.body.expectedOpenChatUserId as string | undefined,
    });
    if (!tx) { res.status(400).json({ error: 'Invalid delegation request' }); return; }
    res.json({ transaction: tx, reviewPath: `/api/connector-delegations/review/${encodeURIComponent(tx)}` });
  });

  router.get('/review/:transaction', requireAuth, requireDirectSession, (req, res) => {
    const review = service.review(req.params.transaction as string, req.user!.userId);
    if (!review) { res.sendStatus(404); return; }
    res.json(review);
  });

  router.post('/consent', requireAuth, requireDirectSession, (req, res) => {
    const { transaction, approvedScopes } = req.body ?? {};
    if (typeof transaction !== 'string' || !Array.isArray(approvedScopes)) { res.sendStatus(400); return; }
    const result = service.consent(transaction, req.user!.userId, approvedScopes);
    if (!result) { res.status(403).json({ error: 'Consent denied' }); return; }
    const callback = new URL(result.callback);
    callback.searchParams.set('code', result.code);
    callback.searchParams.set('state', result.state);
    res.redirect(303, callback.toString());
  });

  router.post('/token', (req, res) => {
    const id = clientId(req, service);
    if (!id || !objectBody(req.body)) { res.sendStatus(401); return; }
    const issued = service.exchange({ clientId: id, callback: req.body.callback as string, code: req.body.code as string,
      verifier: req.body.codeVerifier as string, state: req.body.state as string });
    if (!issued) { res.status(400).json({ error: 'Invalid authorization code' }); return; }
    res.json({ access_token: issued.token, token_type: 'Bearer', expires_in: 3600,
      openchat_user_id: issued.delegation.openChatUserId, scopes: issued.delegation.scopes });
  });

  router.post('/revoke', (req, res) => {
    const id = clientId(req, service);
    if (!id || !objectBody(req.body)) { res.sendStatus(401); return; }
    const { connectorGrantId, connectorUserId, openChatUserId } = req.body;
    if (![connectorGrantId, connectorUserId, openChatUserId].every((v) => typeof v === 'string' && v.length > 0)) {
      res.sendStatus(400); return;
    }
    service.revoke({ clientId: id, connectorGrantId: connectorGrantId as string,
      connectorUserId: connectorUserId as string, openChatUserId: openChatUserId as string });
    res.sendStatus(204);
  });
  return router;
}
