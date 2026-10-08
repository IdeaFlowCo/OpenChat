import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { getDriver } from '../db.js';
import { ContextLaneError } from '../services/contextLane.js';
import { ensureSharedInbox } from '../services/unlinkedMessaging.js';
import { listProfileAsks, mutateProfileAsk, profileAskAudience, publishProfileAsk } from '../services/profileAsks.js';

export const PROFILE_ASK_ISSUER = 'https://id.ideaflow.app/api/auth';
export function validProfileIdentity(value: any): boolean {
  return !!value && !Array.isArray(value) && Object.keys(value).every(k => ['issuer','subject'].includes(k)) && value.issuer === PROFILE_ASK_ISSUER &&
    typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 512 && !Array.from(value.subject as string).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
async function existingInbox(identity: {issuer:string;subject:string}): Promise<string | null> {
  const session = getDriver().session();
  try {
    const result = await session.executeRead(tx => tx.run(`MATCH (u:User {ideaflowIdentityKey:$key,ideaflowIssuer:$issuer,ideaflowSub:$subject}) RETURN u.id AS id LIMIT 2`,
      { key: `${identity.issuer}\u001f${identity.subject}`, ...identity }));
    return result.records.length === 1 ? result.records[0].get('id') : null;
  } finally { await session.close(); }
}
const router = Router();
let windowAt = 0, requests = 0;
// Confidential Unlinked adapter. Actors and viewers are supplied only after the
// caller validates its own HttpOnly session/live binding; browsers cannot call it.
router.post('/unlinked/profile-asks', async (req, res) => {
  res.set('Cache-Control','no-store');
  const secret = process.env.UNLINKED_MESSAGING_SECRET;
  if (!secret || secret.length < 32) { res.status(503).json({error:'asks_unavailable'}); return; }
  if (req.headers.origin) { res.status(403).json({error:'forbidden'}); return; }
  const hash = (value:string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(req.headers.authorization ?? ''),hash(`Bearer ${secret}`))) { res.status(401).json({error:'unauthorized'}); return; }
  if (Date.now()-windowAt >= 60000) { windowAt=Date.now(); requests=0; }
  if (++requests>240) { res.status(429).json({error:'rate_limited'}); return; }
  const input=req.body;
  if (!input || Array.isArray(input) || Object.keys(input).some(k=>!['operation','owner','viewer','askId','input'].includes(k)) ||
      !['list','audience','publish','edit','close','remove'].includes(input.operation) || !validProfileIdentity(input.owner) ||
      (input.viewer != null && !validProfileIdentity(input.viewer))) { res.status(400).json({error:'invalid_input'}); return; }
  const session=getDriver().session();
  try {
    const isOwner = input.viewer?.issuer === input.owner.issuer && input.viewer?.subject === input.owner.subject;
    if (input.operation !== 'list' && !isOwner) throw new ContextLaneError(403,'Owner session required');
    // Reading a public profile never creates an account, conversation or grant.
    const ownerId = input.operation === 'publish' ? (await ensureSharedInbox(input.owner,'Unlinked member')).id : await existingInbox(input.owner);
    const viewerId = isOwner ? ownerId : input.viewer ? await existingInbox(input.viewer) : null;
    if (!ownerId) { res.json(input.operation === 'audience' ? {people:[],groups:[]} : {asks:[]}); return; }
    if (input.operation==='list') res.json({asks:await listProfileAsks(session,ownerId,viewerId,input.askId ?? null)});
    else if (input.operation==='audience') res.json(await profileAskAudience(session,ownerId));
    else if (input.operation==='publish') res.json({ask:await publishProfileAsk(session,ownerId,input.input)});
    else res.json({ask:await mutateProfileAsk(session,ownerId,input.askId,input.operation,input.input)});
  } catch(error) {
    if (error instanceof ContextLaneError) res.status(error.statusCode).json({error:error.message});
    else res.status(503).json({error:'asks_unavailable'});
  } finally { await session.close(); }
});
export default router;
