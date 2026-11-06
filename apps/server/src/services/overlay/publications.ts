/** Durable, explicitly approved snapshots of canonical asks. No viewer API here. */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { askIn } from './store.js';
import { cleanAskText, cleanRequestId, fail, isOwnerKey, type AskStatus } from './contract.js';
type Runner = Pick<ManagedTransaction, 'run'>;
export interface Publication {
  id: string; ownerKey: string; askId: string; revision: number; sourceRevision: number;
  text: string; lifecycle: AskStatus; publisherRef: string; audienceKind: 'public' | 'people'; recipientKeys: string[]; recipientRefs: string[];
  state: 'active' | 'revoked'; createdAt: string; updatedAt: string; revokedAt: string | null;
}
export interface PublicationInput {
  requestId: string; expectedAskRevision: number; expectedPublicationRevision: number | null; text: string;
  audienceKind: 'public' | 'people'; recipientKeys: string[]; recipientRefs?: string[]; publisherRef: string;
}
const number = (value: unknown): number => neo4j.isInt(value) ? value.toNumber() : Number(value);
export function publicationFrom(value: Record<string, unknown>): Publication {
  return { id: String(value.id), ownerKey: String(value.ownerKey), askId: String(value.askId), revision: number(value.revision), sourceRevision: number(value.sourceRevision), text: String(value.text), lifecycle: value.lifecycle as AskStatus, publisherRef: String(value.publisherRef), audienceKind: value.audienceKind as Publication['audienceKind'], recipientKeys: (value.recipientKeys as string[]) ?? [], recipientRefs: (value.recipientRefs as string[]) ?? [], state: value.state as Publication['state'], createdAt: String(value.createdAt), updatedAt: String(value.updatedAt), revokedAt: typeof value.revokedAt === 'string' ? value.revokedAt : null };
}
/** Only the trusted app adapter supplies publisher/recipient identity keys. */
export function cleanPublicationInput(input: PublicationInput): PublicationInput {
  if (!Number.isSafeInteger(input.expectedAskRevision) || input.expectedAskRevision < 0 || (input.expectedPublicationRevision !== null && (!Number.isSafeInteger(input.expectedPublicationRevision) || input.expectedPublicationRevision < 0))) return fail(400, 'invalid_revision');
  if (!/^openchat:user:[A-Za-z0-9_%.-]{1,200}$/.test(input.publisherRef)) return fail(400, 'invalid_publisher');
  const keys = Array.isArray(input.recipientKeys) ? [...new Set(input.recipientKeys)].sort() : [];
  if (input.audienceKind === 'public' ? keys.length !== 0 : input.audienceKind !== 'people' || keys.length < 1 || keys.length > 20 || keys.some(key => !isOwnerKey(key))) return fail(400, 'invalid_audience');
  const refs = [...new Set(input.recipientRefs ?? [])].sort();
  if (refs.length > 20 || refs.some(ref => !/^openchat:user:[A-Za-z0-9_%.-]{1,200}$/.test(ref)) || (input.audienceKind === 'public' && refs.length)) return fail(400, 'invalid_audience');
  return { recipientRefs: refs, requestId: cleanRequestId(input.requestId), expectedAskRevision: input.expectedAskRevision, expectedPublicationRevision: input.expectedPublicationRevision, text: cleanAskText(input.text), audienceKind: input.audienceKind, recipientKeys: keys, publisherRef: input.publisherRef };
}
export const publicationDigest = (askId: string, input: PublicationInput): string => createHash('sha256').update(JSON.stringify({ askId, ...cleanPublicationInput(input) })).digest('hex');
export async function publicationIn(tx: Runner, ownerKey: string, askId: string): Promise<Publication | null> {
  const found = await tx.run('MATCH (p:OverlayAskPublication {ownerKey:$ownerKey,askId:$askId}) RETURN properties(p) AS publication', { ownerKey, askId });
  return found.records[0] ? publicationFrom(found.records[0].get('publication')) : null;
}
export async function checkPublicationIn(tx: Runner, ownerKey: string, askId: string, input: PublicationInput) {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  const ask = await askIn(tx, ownerKey, askId), publication = await publicationIn(tx, ownerKey, askId);
  if (!ask.fromMe) return fail(400, 'unsupported_author');
  if (ask.status === 'withdrawn') return fail(409, 'ask_withdrawn');
  if (ask.revision !== input.expectedAskRevision || (publication?.revision ?? null) !== input.expectedPublicationRevision) return fail(409, 'revision_conflict');
  return { ask, publication };
}
/** Look up before checking current revisions or consuming a new approval on retry. */
export async function publicationReplayIn(tx: Runner, ownerKey: string, askId: string, input: PublicationInput): Promise<{ publication: Publication; committedRevision: number; replay: true } | null> {
  const found = await tx.run('MATCH (o:OverlayAskPublicationOperation {ownerKey:$ownerKey,requestId:$requestId}) RETURN o.payloadDigest AS digest,o.askId AS askId,o.publicationRevision AS revision', { ownerKey, requestId: input.requestId });
  if (!found.records[0] || !found.records[0].get('digest')) return null;
  if (found.records[0].get('digest') !== publicationDigest(askId, input) || found.records[0].get('askId') !== askId) return fail(409, 'publication_operation_conflict');
  const publication = await publicationIn(tx, ownerKey, askId);
  if (!publication) return fail(410, 'publication_removed');
  return { publication, committedRevision: number(found.records[0].get('revision')), replay: true };
}
/** Trusted app retry lookup, before current recipient resolution; never creates/reactivates a grant. */
export async function publicationRequestReplayIn(tx: Runner, ownerKey: string, askId: string, requestId: string, fingerprint: string) {
  const found = await tx.run('MATCH (o:OverlayAskPublicationOperation {ownerKey:$ownerKey,requestId:$requestId}) RETURN o.requestFingerprint AS fingerprint,o.askId AS askId,o.publicationRevision AS revision', { ownerKey, requestId });
  if (!found.records[0] || !found.records[0].get('fingerprint')) return null;
  if (found.records[0].get('fingerprint') !== fingerprint || found.records[0].get('askId') !== askId) return fail(409, 'publication_operation_conflict');
  const publication = await publicationIn(tx, ownerKey, askId);
  if (!publication) return fail(410, 'publication_removed');
  return { publication, committedRevision: number(found.records[0].get('revision')), replay: true };
}
export async function commitPublicationIn(tx: Runner, ownerKey: string, askId: string, raw: PublicationInput, consumeApproval: () => boolean, requestFingerprint: string | null = null) {
  const input = cleanPublicationInput(raw);
  await tx.run('MERGE (o:OverlayAskPublicationOperation {ownerKey:$ownerKey,requestId:$requestId}) SET o._lock=true REMOVE o._lock', { ownerKey, requestId: input.requestId });
  const replay = await publicationReplayIn(tx, ownerKey, askId, input);
  if (replay) return replay;
  await tx.run("MATCH (a:OverlayEntity {ownerKey:$ownerKey,id:$askId,kind:'ask'}) SET a._lock=true REMOVE a._lock", { ownerKey, askId });
  // Another operation on the same ask may have committed while this one waited.
  const afterLock = await publicationReplayIn(tx, ownerKey, askId, input);
  if (afterLock) return afterLock;
  const { ask, publication } = await checkPublicationIn(tx, ownerKey, askId, input);
  if (!consumeApproval()) return fail(409, 'publication_approval_required');
  const id = publication?.id ?? nanoid(), revision = (publication?.revision ?? -1) + 1, now = new Date().toISOString();
  await tx.run(`MERGE (p:OverlayAskPublication {ownerKey:$ownerKey,askId:$askId})
    ON CREATE SET p.id=$id,p.createdAt=$now
    SET p.revision=$revision,p.sourceRevision=$sourceRevision,p.text=$text,p.lifecycle=$lifecycle,p.publisherRef=$publisherRef,
      p.audienceKind=$audienceKind,p.recipientKeys=$recipientKeys,p.recipientRefs=$recipientRefs,p.state='active',p.updatedAt=$now,p.revokedAt=null`, { ...input, ownerKey, askId, id, now, revision: neo4j.int(revision), sourceRevision: neo4j.int(ask.revision), lifecycle: ask.status });
  await tx.run(`MATCH (o:OverlayAskPublicationOperation {ownerKey:$ownerKey,requestId:$requestId}) SET o.askId=$askId,o.payloadDigest=$digest,o.publicationId=$id,o.publicationRevision=$revision,o.requestFingerprint=$requestFingerprint`, { ownerKey, askId, requestId: input.requestId, digest: publicationDigest(askId, input), requestFingerprint, id, revision: neo4j.int(revision) });
  return { publication: (await publicationIn(tx, ownerKey, askId))!, committedRevision: revision, replay: false };
}
export async function revokePublicationIn(tx: Runner, ownerKey: string, askId: string, expectedRevision: unknown) {
  await tx.run("MATCH (a:OverlayEntity {ownerKey:$ownerKey,id:$askId,kind:'ask'}) SET a._lock=true REMOVE a._lock", { ownerKey, askId });
  await askIn(tx, ownerKey, askId);
  const current = await publicationIn(tx, ownerKey, askId);
  if (!current || current.state === 'revoked') return current;
  if (current.revision !== expectedRevision) return fail(409, 'revision_conflict');
  await revokeAskPublicationIn(tx, ownerKey, askId);
  return publicationIn(tx, ownerKey, askId);
}
export async function revokeAskPublicationIn(tx: Runner, ownerKey: string, askId: string): Promise<void> {
  await tx.run(`MATCH (p:OverlayAskPublication {ownerKey:$ownerKey,askId:$askId,state:'active'})
    SET p.state='revoked',p.revokedAt=$now,p.updatedAt=$now,p.revision=p.revision+1`, { ownerKey, askId, now: new Date().toISOString() });
}
export async function eraseAskPublicationIn(tx: Runner, ownerKey: string, askId: string): Promise<void> {
  for (const label of ['OverlayAskPublication', 'OverlayAskPublicationOperation']) await tx.run(`MATCH (p:${label} {ownerKey:$ownerKey,askId:$askId}) DETACH DELETE p`, { ownerKey, askId });
}
