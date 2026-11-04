/** OpenChat identity/block policy around the Noos ask-publication transaction boundary. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';
import { privateReviewPrincipal, PrivateGraphError } from './privateGraph.js';
import { ownerKeyFor, OverlayError } from './overlay/contract.js';
import { askIn } from './overlay/store.js';
import { checkPublicationIn, cleanPublicationInput, commitPublicationIn, publicationFrom, publicationIn, publicationReplayIn, revokePublicationIn, type PublicationInput, type Publication } from './overlay/publications.js';
import { consumePublicationApproval, issuePublicationApproval } from './publicationApproval.js';
import { resolveUnlinkedIdentity } from './unlinkedMessaging.js';
type Runner = Pick<ManagedTransaction, 'run'>;
const LOCAL_ISSUER = 'https://chat.ideaflow.app/openchat-user';
const localKey = (id: string) => ownerKeyFor(LOCAL_ISSUER, id);
const ref = (id: string) => `openchat:user:${encodeURIComponent(id)}`;
const fail = (status: number, message: string): never => { throw new PrivateGraphError(status, message); };
const alive = (alias: string) => `${alias}.deletedAt IS NULL AND ${alias}.suspendedAt IS NULL AND coalesce(${alias}.suspended,false)=false`;
interface Target { kind: 'openchat_user' | 'unlinked_profile'; id: string }
interface PublishRequest { requestId: string; expectedAskRevision: number; expectedPublicationRevision: number | null; text: string; audience: { kind: 'public' | 'people'; targets: Target[] }; confirm: boolean; approvalGrant?: string }
function request(raw: unknown): PublishRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'Invalid publication request');
  const value = raw as Record<string, any>;
  if (Object.keys(value).some(key => !['requestId','expectedAskRevision','expectedPublicationRevision','text','audience','confirm','approvalGrant'].includes(key))) return fail(400, 'Unknown publication field');
  const audience = value.audience;
  if (!audience || typeof audience !== 'object' || Array.isArray(audience) || Object.keys(audience).some(key => !['kind','targets'].includes(key)) || !['public','people'].includes(audience.kind)) return fail(400, 'Choose Public or selected people');
  const targets = audience.targets ?? [];
  if (!Array.isArray(targets) || (audience.kind === 'public' ? targets.length !== 0 : targets.length < 1 || targets.length > 20)) return fail(400, 'Choose one to twenty verified recipients');
  for (const target of targets) if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['kind','id'].includes(key)) || !['openchat_user','unlinked_profile'].includes(target.kind) || typeof target.id !== 'string' || !target.id || target.id.length > 200 || /\s/.test(target.id)) return fail(400, 'Recipients must be verified account/profile references, not names or email addresses');
  if (value.confirm !== true && value.confirm !== false) return fail(400, 'confirm must be true or false');
  return { ...value, audience: { kind: audience.kind, targets } } as PublishRequest;
}
async function userIn(tx: Runner, id: string) {
  const result = await tx.run(`MATCH (u:User {id:$id}) WHERE ${alive('u')} RETURN u.id AS id,u.name AS name,u.ideaflowIssuer AS issuer,u.ideaflowSub AS subject`, { id });
  const row = result.records[0];
  if (!row) return fail(404, 'Account unavailable');
  const issuer = row.get('issuer'), subject = row.get('subject');
  if ((typeof issuer === 'string' && !!issuer) !== (typeof subject === 'string' && !!subject)) return fail(409, 'Account identity is incomplete');
  return { id, name: normalizePublicDisplayName(row.get('name')), key: typeof issuer === 'string' && issuer && typeof subject === 'string' && subject ? ownerKeyFor(issuer, subject) : localKey(id) };
}
async function resolveTargets(raw: PublishRequest): Promise<Target[]> {
  const targets: Target[] = [];
  for (const target of raw.audience.targets) {
    if (target.kind === 'openchat_user') { targets.push(target); continue; }
    let resolved;
    try { resolved = await resolveUnlinkedIdentity(target.id); } catch { return fail(503, 'Recipient identity service unavailable'); }
    if (resolved.status !== 'member') return fail(resolved.status === 'unclaimed' ? 409 : 503, resolved.status === 'unclaimed' ? 'Recipient profile is unclaimed; private ask remains saved' : 'Recipient identity service unavailable');
    const db = getDriver().session();
    try {
      const result = await db.run(`MATCH (u:User {ideaflowIssuer:$issuer,ideaflowSub:$subject}) WHERE ${alive('u')} RETURN u.id AS id LIMIT 2`, resolved.identity);
      if (result.records.length !== 1) return fail(409, 'Recipient needs an existing verified OpenChat account; private ask remains saved');
      targets.push({ kind: 'openchat_user', id: String(result.records[0]!.get('id')) });
    } finally { await db.close(); }
  }
  return targets;
}
async function preparedIn(tx: Runner, ownerId: string, ownerKey: string, raw: PublishRequest, targets: Target[]) {
  const publisher = await userIn(tx, ownerId);
  const recipients = [];
  for (const target of targets) {
    if (target.id === ownerId) return fail(400, 'Selected people must be other accounts');
    const recipient = await userIn(tx, target.id);
    const blocked = await tx.run('MATCH (:User {id:$ownerId})-[:BLOCKED]-(:User {id:$recipientId}) RETURN count(*) AS count', { ownerId, recipientId: target.id });
    if (Number(blocked.records[0]?.get('count')?.toString() ?? 0)) return fail(404, 'Recipient unavailable');
    recipients.push(recipient);
  }
  const input = cleanPublicationInput({ requestId: raw.requestId, expectedAskRevision: raw.expectedAskRevision, expectedPublicationRevision: raw.expectedPublicationRevision, text: raw.text, audienceKind: raw.audience.kind, recipientKeys: recipients.map(person => person.key), publisherRef: ref(ownerId) });
  return { input, publisher: { userId: ownerId, displayName: publisher.name }, recipients: [...new Map(recipients.map(person => [person.key, { userId: person.id, displayName: person.name }])).values()].sort((a,b) => a.userId.localeCompare(b.userId)), ownerKey };
}
async function work<T>(fn: (tx: ManagedTransaction) => Promise<T>, write = false): Promise<T> {
  const db = getDriver().session();
  try { return write ? await db.executeWrite(fn) : await db.executeRead(fn); }
  catch (error) { if (error instanceof OverlayError) throw new PrivateGraphError(error.status, error.code, error.details); throw error; }
  finally { await db.close(); }
}
export async function getAskPublication(ownerId: string, askId: string) {
  const { ownerKey } = await privateReviewPrincipal(ownerId);
  return work(async tx => { const ask = await askIn(tx, ownerKey, askId); const publication = await publicationIn(tx, ownerKey, askId); return { publication, askRevision: ask.revision, publishedVersionDiffers: !!publication && publication.sourceRevision !== ask.revision }; });
}
export async function publishAsk(ownerId: string, actor: string, askId: string, value: unknown) {
  const raw = request(value), targets = await resolveTargets(raw);
  const { ownerKey } = await privateReviewPrincipal(ownerId);
  return work(async tx => {
    const prepared = await preparedIn(tx, ownerId, ownerKey, raw, targets);
    const approvalPayload = { askId, ...prepared.input, publisher: prepared.publisher, recipients: prepared.recipients, expiresAt: null, notifications: false, quietMatching: false };
    if (raw.confirm) {
      const replay = await publicationReplayIn(tx, ownerKey, askId, prepared.input);
      if (replay) return { ...replay, notifications: false, quietMatching: false };
      return { ...(await commitPublicationIn(tx, ownerKey, askId, prepared.input, () => consumePublicationApproval(raw.approvalGrant, actor, 'publish_ask', approvalPayload))), notifications: false, quietMatching: false };
    }
    const { ask } = await checkPublicationIn(tx, ownerKey, askId, prepared.input);
    return { approvalRequired: true, preview: { text: prepared.input.text, lifecycle: ask.status, publisher: prepared.publisher, audience: raw.audience.kind, recipients: prepared.recipients, expiresAt: null, notifications: false, quietMatching: false }, approvalGrant: issuePublicationApproval(actor, 'publish_ask', approvalPayload) };
  }, raw.confirm);
}
export async function revokeAskPublication(ownerId: string, askId: string, expectedPublicationRevision: unknown) {
  const { ownerKey } = await privateReviewPrincipal(ownerId);
  return work(async tx => ({ publication: await revokePublicationIn(tx, ownerKey, askId, expectedPublicationRevision) }), true);
}

export interface PublishedAskView { id: string; revision: number; text: string; lifecycle: string; publishedAt: string; updatedAt: string; publisher: { userId: string; displayName: string }; audience: 'public' | 'shared_with_you' }
function view(p: Publication, publisherId: string, name: unknown): PublishedAskView {
  return { id: p.id, revision: p.revision, text: p.text, lifecycle: p.lifecycle, publishedAt: p.createdAt, updatedAt: p.updatedAt, publisher: { userId: publisherId, displayName: normalizePublicDisplayName(name) }, audience: p.audienceKind === 'public' ? 'public' : 'shared_with_you' };
}
async function viewerIn(tx: Runner, viewerId: string | null) {
  if (!viewerId) return [];
  const person = await userIn(tx, viewerId), local = localKey(viewerId);
  if (person.key === local) return [local];
  const counts = await tx.run(`OPTIONAL MATCH (a:OverlayEntity {ownerKey:$local}) WITH count(a) AS localCount OPTIONAL MATCH (b:OverlayEntity {ownerKey:$canonical}) RETURN localCount,count(b) AS canonicalCount`, { local, canonical: person.key });
  const row = counts.records[0];
  const conflict = Number(row?.get('localCount')?.toString() ?? 0) > 0 && Number(row?.get('canonicalCount')?.toString() ?? 0) > 0;
  return conflict ? [person.key] : [person.key, local];
}
const digestViewer = (viewerId: string | null) => createHash('sha256').update(viewerId ?? 'anonymous').digest('hex');
function cursorToken(value: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', process.env.JWT_SECRET || 'dev-secret-change-me').update(data).digest('base64url');
  return `${data}.${signature}`;
}
function readCursor(raw: unknown, binding: string): { at: string; id: string } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 2048) return fail(400, 'Invalid cursor');
  try {
    const [data, signature] = raw.split('.'); if (!data || !signature) return fail(400, 'Invalid cursor');
    const expected = cursorToken(JSON.parse(Buffer.from(data, 'base64url').toString())).split('.')[1]!;
    const a = Buffer.from(signature), b = Buffer.from(expected); if (a.length !== b.length || !timingSafeEqual(a,b)) return fail(400, 'Invalid cursor');
    const value = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (value.binding !== binding || typeof value.at !== 'string' || typeof value.id !== 'string') return fail(400, 'Cursor does not match this viewer or filter');
    return { at: value.at, id: value.id };
  } catch { return fail(400, 'Invalid cursor'); }
}
const readable = `p.state='active' AND ${alive('publisher')} AND source.ownerKey=p.ownerKey
  AND ($viewerId IS NULL OR publisher.id=$viewerId OR NOT EXISTS { MATCH (:User {id:$viewerId})-[:BLOCKED]-(publisher) })
  AND (p.audienceKind='public' OR any(key IN $viewerKeys WHERE key IN p.recipientKeys) OR publisher.id=$viewerId)`;
export async function readAskPublication(viewerId: string | null, publicationId: string) {
  return work(async tx => {
    const viewerKeys = await viewerIn(tx, viewerId);
    const found = await tx.run(`MATCH (p:OverlayAskPublication {id:$publicationId}), (source:OverlayEntity {id:p.askId,ownerKey:p.ownerKey,kind:'ask'}), (publisher:User)
      WHERE p.publisherRef = 'openchat:user:' + publisher.id AND ${readable}
      RETURN properties(p) AS publication,publisher.id AS publisherId,publisher.name AS name`, { publicationId, viewerId, viewerKeys });
    const row = found.records[0]; if (!row) return fail(404, 'Ask unavailable');
    return { publication: view(publicationFrom(row.get('publication')), row.get('publisherId'), row.get('name')) };
  });
}
export async function listAskPublications(viewerId: string | null, input: { publisherId?: string; sharedOnly?: boolean; cursor?: unknown; limit?: unknown }) {
  if (input.sharedOnly && !viewerId) return fail(401, 'Sign in required');
  const binding = JSON.stringify([digestViewer(viewerId), input.publisherId ?? null, input.sharedOnly === true]);
  const cursor = readCursor(input.cursor, binding), limit = typeof input.limit === 'string' && /^\d+$/.test(input.limit) ? Math.min(50, Math.max(1, Number(input.limit))) : 50;
  return work(async tx => {
    const viewerKeys = await viewerIn(tx, viewerId);
    const result = await tx.run(`MATCH (p:OverlayAskPublication), (source:OverlayEntity {id:p.askId,ownerKey:p.ownerKey,kind:'ask'}), (publisher:User)
      WHERE p.publisherRef = 'openchat:user:' + publisher.id AND ${readable}
        AND ($publisherId IS NULL OR publisher.id=$publisherId)
        AND (NOT $sharedOnly OR (p.audienceKind='people' AND any(key IN $viewerKeys WHERE key IN p.recipientKeys)))
        AND ($beforeAt IS NULL OR p.updatedAt < $beforeAt OR (p.updatedAt=$beforeAt AND p.id < $beforeId))
      RETURN properties(p) AS publication,publisher.id AS publisherId,publisher.name AS name ORDER BY p.updatedAt DESC,p.id DESC LIMIT $limit`, { viewerId, viewerKeys, publisherId: input.publisherId ?? null, sharedOnly: input.sharedOnly === true, beforeAt: cursor?.at ?? null, beforeId: cursor?.id ?? null, limit: neo4j.int(limit + 1) });
    const rows = result.records.slice(0,limit), last = rows.at(-1), p = last ? publicationFrom(last.get('publication')) : null;
    return { publications: rows.map(row => view(publicationFrom(row.get('publication')), row.get('publisherId'), row.get('name'))), nextCursor: result.records.length > limit && p ? cursorToken({ binding, at: p.updatedAt, id: p.id }) : null };
  });
}
