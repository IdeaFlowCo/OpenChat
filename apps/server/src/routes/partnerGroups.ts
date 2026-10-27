import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { getDriver } from '../db.js';

// Ideaflow ideas network (social.ideaflow.app) group rosters, OpenChat-vwgq.8.
// A group page there can be bound to an OpenChat group conversation, which is the
// membership authority. This confidential read (service secret, no browser Origin)
// answers only when the asking Ideaflow identity is itself a participant of that
// group conversation, so a roster is never shown to non-members. It returns each
// member's display name, role and Ideaflow owner key (sha256(issuer + "\n" + sub),
// the key Noos, WIT and the ideas network share) — no emails, user ids, raw
// subjects, messages or presence. Non-members and unknown conversations get the
// same { member: false } answer.
const ISSUER = 'https://id.ideaflow.app/api/auth';
export const PARTNER_GROUP_ROSTER_QUERY = `
      MATCH (viewer:User)-[vr:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      WHERE viewer.ideaflowIssuer = $issuer AND viewer.ideaflowSub = $subject AND c.type = 'group'
      WITH c, vr ORDER BY CASE vr.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1
      MATCH (member:User)-[rel:PARTICIPATES_IN]->(c)
      RETURN c.title AS title, vr.role AS viewerRole,
        collect({ name: member.name, role: rel.role, isBot: coalesce(member.isBot, false),
          issuer: member.ideaflowIssuer, subject: member.ideaflowSub }) AS members
    `;
export const ownerKey = (issuer: string, subject: string) => createHash('sha256').update(`${issuer}\n${subject}`).digest('hex');

const router = Router();
let window = 0, requests = 0;
router.post('/partners/ideanetwork/group-roster', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.IDEANETWORK_PARTNER_SECRET;
  if (!secret || secret.length < 32) { res.status(503).json({ error: 'partner_unavailable' }); return; }
  if (req.headers.origin) { res.status(403).json({ error: 'forbidden' }); return; }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${secret}`))) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (Date.now() - window >= 60000) { window = Date.now(); requests = 0; }
  if (++requests > 600) { res.status(429).json({ error: 'rate_limited' }); return; }
  const input = req.body;
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['issuer', 'subject', 'conversationId'].includes(key)) ||
      input.issuer !== ISSUER || typeof input.subject !== 'string' || !input.subject || input.subject.length > 512 ||
      Array.from(input.subject as string).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      typeof input.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.conversationId)) {
    res.status(400).json({ error: 'invalid_input' }); return;
  }
  const session = getDriver().session({ defaultAccessMode: 'READ' });
  try {
    const result = await session.run(PARTNER_GROUP_ROSTER_QUERY, { issuer: ISSUER, subject: input.subject, conversationId: input.conversationId });
    const record = result.records[0];
    if (!record) { res.json({ member: false }); return; }
    const members = (record.get('members') as Array<{ name: unknown; role: unknown; isBot: unknown; issuer: unknown; subject: unknown }>).map(m => ({
      name: typeof m.name === 'string' ? m.name : '',
      role: m.role === 'owner' || m.role === 'admin' ? m.role : 'member',
      isBot: m.isBot === true,
      ownerKey: m.issuer === ISSUER && typeof m.subject === 'string' && m.subject ? ownerKey(ISSUER, m.subject) : null,
    }));
    res.json({ member: true, viewerRole: record.get('viewerRole') ?? 'member', title: record.get('title') ?? null,
      conversationUrl: `https://chat.ideaflow.app/app/chat/${encodeURIComponent(input.conversationId)}`, members });
  } catch { res.status(503).json({ error: 'partner_unavailable' }); }
  finally { await session.close(); }
});

export default router;
