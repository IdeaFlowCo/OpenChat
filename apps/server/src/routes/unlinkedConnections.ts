import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { parseAcceptedConnection, syncAcceptedUnlinkedConnection, UnlinkedConnectionError } from '../services/unlinkedConnections.js';

const router = Router();
let windowAt = 0, requests = 0;
router.post('/unlinked/connections/accepted', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.UNLINKED_MESSAGING_SECRET;
  if (!secret || secret.length < 32) { res.status(503).json({ error: 'connection_sync_unavailable' }); return; }
  if (req.headers.origin) { res.status(403).json({ error: 'forbidden' }); return; }
  const hash = (s: string) => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${secret}`))) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (Date.now() - windowAt >= 60000) { windowAt = Date.now(); requests = 0; }
  if (++requests > 120) { res.status(429).json({ error: 'rate_limited' }); return; }
  try { res.json(await syncAcceptedUnlinkedConnection(parseAcceptedConnection(req.body))); }
  catch (error) {
    if (error instanceof UnlinkedConnectionError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(503).json({ error: 'connection_sync_unavailable' });
  }
});
export default router;
