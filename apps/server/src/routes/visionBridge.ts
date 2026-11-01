import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { ensureAssistantConversation } from '../services/assistant.js';
import { AGENT_HANDLE, AGENT_HANDLE_DISPLAY_NAME, normalizeHandle, VISION_ISSUER, validSubject } from '../services/visionBridge.js';

const router = Router();

// A confidential exchange modelled on /unlinked/session: only the authenticated
// Vision server supplies the verified Ideaflow identity. Unlike Unlinked's shared
// inbox, this acts for the EXISTING OpenChat account already bound to that
// identity and never creates one. Browser-selected identities are never accepted.
let sessionWindow = 0, sessionRequests = 0;
router.post('/vision/session', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.VISION_MESSAGING_SECRET;
  if (!secret || secret.length < 32 || !process.env.JWT_SECRET) { res.status(503).json({ error: 'messaging_unavailable' }); return; }
  if (req.headers.origin) { res.status(403).json({ error: 'forbidden' }); return; }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${secret}`))) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (Date.now() - sessionWindow >= 60000) { sessionWindow = Date.now(); sessionRequests = 0; }
  if (++sessionRequests > 120) { res.status(429).json({ error: 'rate_limited' }); return; }
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['issuer', 'subject', 'name'].includes(key)) ||
      input.issuer !== VISION_ISSUER || !validSubject(input.subject) || (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 160))) {
    res.status(400).json({ error: 'invalid_identity' }); return;
  }
  const session = getDriver().session({ defaultAccessMode: 'READ' });
  try {
    // Exactly one linked account, and one that has really signed into OpenChat
    // (a pending Unlinked shared inbox is not a login). `name` is display-only.
    const result = await session.run(`MATCH (u:User {ideaflowIssuer:$issuer, ideaflowSub:$subject})
      WHERE coalesce(u.isBot, false) = false
      RETURN u.id AS id, u.name AS name, coalesce(u.sharedInboxPending, false) AS pending LIMIT 2`, { issuer: VISION_ISSUER, subject: input.subject });
    const row = result.records.length === 1 ? result.records[0] : null;
    if (!row || typeof row.get('id') !== 'string' || row.get('pending') === true) { res.status(409).json({ error: 'account_link_required' }); return; }
    // The placeholder only satisfies the JWT envelope; the account's real email is
    // never disclosed to the partner. Identity and access are by immutable userId.
    const user = { userId: row.get('id') as string, name: typeof row.get('name') === 'string' ? row.get('name') as string : '', email: 'vision-session@ideaflow.invalid' };
    const token = jwt.sign({ ...user, embedded: 'vision' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ token, user, expiresIn: 600 });
  } catch { res.status(503).json({ error: 'messaging_unavailable' }); }
  finally { await session.close(); }
});

// Resolve a reserved handle to the caller's own target. Only Vision partner
// sessions and unified-connector principals use it; `agent` is the caller's
// private two-member assistant DM (created on first use, like /assistant/ensure).
router.get('/vision/targets/resolve', resolveActor, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.user?.embedded !== 'vision' && !getConnectorPrincipal(req)) { res.status(403).json({ error: 'Not available to this session' }); return; }
  const handle = typeof req.query.handle === 'string' ? normalizeHandle(req.query.handle) : '';
  if (handle !== AGENT_HANDLE) { res.status(404).json({ error: 'unknown_handle' }); return; }
  try {
    const conversationId = await ensureAssistantConversation(req.user!.userId, req.app.get('io') as IOServer | undefined);
    res.json({ handle: AGENT_HANDLE, kind: 'agent', displayName: AGENT_HANDLE_DISPLAY_NAME, conversationId });
  } catch { res.status(503).json({ error: 'resolve_unavailable' }); }
});

export default router;
