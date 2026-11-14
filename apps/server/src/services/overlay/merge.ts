import { createHash } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { nanoid } from 'nanoid';
import { cleanRequestId, fail, isId } from './contract.js';
import { stableJSON } from './contacts.js';
import type { Provenance } from './contract.js';

/**
 * People resolution, slice 1: pointer merge (docs/PEOPLE_OVERLAY.md, "Merging people").
 *
 * Nothing moves. A merged-away person keeps every note, link, ref, source card
 * and setting it ever had; it only gains `mergedInto: <head id>` and the id of
 * the merge event that set it. The head is an ordinary entity without a
 * pointer, and reads answer for the head plus its members. Pointers stay flat:
 * `mergedInto` always names a head, never another member.
 *
 * Every membership change is an append-only `OverlayMergeEvent` carrying, for
 * each entity it re-pointed, the pointer before and after. Reverting an event
 * restores the "before" values only while every pointer it set is still in
 * place, so a later merge or split is never silently undone (409
 * `merge_superseded`). A split removes one member and records a "different"
 * identity decision, which later merges respect (409 `cannot_link`).
 */

type Runner = Pick<ManagedTransaction, 'run'>;
type By = Provenance & { actorId: string };

export const MERGE_CONSTRAINTS = [
  'CREATE CONSTRAINT overlay_merge_event_id IF NOT EXISTS FOR (m:OverlayMergeEvent) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT overlay_merge_operation IF NOT EXISTS FOR (m:OverlayMergeEvent) REQUIRE (m.ownerKey, m.operationId) IS UNIQUE',
  'CREATE INDEX overlay_entity_merged IF NOT EXISTS FOR (e:OverlayEntity) ON (e.ownerKey, e.mergedInto)',
  'CREATE INDEX overlay_merge_event_owner IF NOT EXISTS FOR (m:OverlayMergeEvent) ON (m.ownerKey, m.batchId)',
  'CREATE INDEX overlay_identity_decision_owner IF NOT EXISTS FOR (d:OverlayIdentityDecision) ON (d.ownerKey)',
];
/** Owner-scoped labels that follow owner erasure and rekeying. */
export const MERGE_LABELS = ['OverlayMergeEvent', 'OverlayIdentityDecision'] as const;

export const MERGE_LIMITS = { idsPerRequest: 50, clusterSize: 50, evidence: 40, evidenceLength: 300, batchRevert: 1000 } as const;

export interface MergeInput { ids: string[]; headId: string | null; rule: string; evidence: string[]; batchId: string | null; operationId: string }
export interface SplitInput { id: string; operationId: string; reason: string | null; decision: boolean }
export interface RevertInput { eventId: string | null; batchId: string | null; operationId?: string | null }
export interface PointerChange { id: string; before: { mergedInto: string | null; mergeEventId: string | null }; after: { mergedInto: string | null; mergeEventId: string | null } }
export interface MergeEvent {
  id: string; kind: 'merge' | 'split' | 'revert' | 'noop' | 'revert-receipt'; headId: string; memberIds: string[]; changes: PointerChange[];
  rule: string | null; evidence: string[]; batchId: string | null; operationId: string | null; revertOf: string | null;
  actor: string | null; actorId: string | null; at: string; revertedAt: string | null; revertedBy: string | null;
  result?: { reverted: string[]; skipped: string[] };
}
export interface Member { id: string; name: string; mergeEventId: string | null }

const RULE = /^[a-z0-9][a-z0-9+:._-]{0,119}$/;
const BATCH = /^[A-Za-z0-9._:-]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseMergeInput(raw: unknown): MergeInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_merge');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['ids', 'headId', 'rule', 'evidence', 'batchId', 'operationId'].includes(key))) return fail(400, 'invalid_merge');
  if (!Array.isArray(input.ids) || input.ids.length < 2 || input.ids.length > MERGE_LIMITS.idsPerRequest || !input.ids.every(isId)) return fail(400, 'invalid_merge');
  const ids = [...new Set(input.ids as string[])];
  if (ids.length < 2) return fail(400, 'invalid_merge');
  const headId = input.headId === undefined || input.headId === null ? null : isId(input.headId) ? input.headId : fail(400, 'invalid_merge');
  if (headId !== null && !ids.includes(headId)) return fail(400, 'invalid_head');
  const rule = typeof input.rule === 'string' && RULE.test(input.rule) ? input.rule : fail(400, 'invalid_merge');
  const evidence = input.evidence === undefined ? [] : Array.isArray(input.evidence) && input.evidence.length <= MERGE_LIMITS.evidence
    && input.evidence.every(item => typeof item === 'string' && item.length >= 1 && item.length <= MERGE_LIMITS.evidenceLength && !CONTROL.test(item))
    ? [...new Set(input.evidence as string[])].sort() : fail(400, 'invalid_merge');
  const batchId = input.batchId === undefined || input.batchId === null ? null : typeof input.batchId === 'string' && BATCH.test(input.batchId) ? input.batchId : fail(400, 'invalid_merge');
  return { ids, headId, rule, evidence, batchId, operationId: cleanRequestId(input.operationId) };
}

export function parseSplitInput(raw: unknown): SplitInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_split');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['id', 'operationId', 'reason', 'decision'].includes(key))) return fail(400, 'invalid_split');
  if (!isId(input.id)) return fail(400, 'invalid_split');
  const reason = input.reason === undefined || input.reason === null ? null
    : typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 280 && !CONTROL.test(input.reason) ? input.reason.trim() : fail(400, 'invalid_split');
  if (input.decision !== undefined && typeof input.decision !== 'boolean') return fail(400, 'invalid_split');
  return { id: input.id, operationId: cleanRequestId(input.operationId), reason, decision: input.decision !== false };
}

export function parseRevertInput(raw: unknown): RevertInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_revert');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['eventId', 'batchId', 'operationId'].includes(key))) return fail(400, 'invalid_revert');
  const eventId = input.eventId === undefined || input.eventId === null ? null : isId(input.eventId) ? input.eventId : fail(400, 'invalid_revert');
  const batchId = input.batchId === undefined || input.batchId === null ? null : typeof input.batchId === 'string' && BATCH.test(input.batchId) ? input.batchId : fail(400, 'invalid_revert');
  if ((eventId === null) === (batchId === null)) return fail(400, 'invalid_revert');
  return { eventId, batchId, ...(input.operationId === undefined ? {} : { operationId: cleanRequestId(input.operationId) }) };
}

/** Serializes every membership change of one owner (the same per-owner clock other overlay writes lock). */
async function lockOwner(tx: Runner, ownerKey: string): Promise<void> {
  await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0 SET c._lock=true REMOVE c._lock', { ownerKey });
}

/** The head an id resolves to (itself when not merged), or null when the owner has no such entity. */
export async function headOf(tx: Runner, ownerKey: string, id: string): Promise<string | null> {
  if (!isId(id)) return null;
  const found = await tx.run("MATCH (e:OverlayEntity {ownerKey:$ownerKey, id:$id}) WHERE e.kind <> 'blurb' OR e.deletedAt IS NULL RETURN coalesce(e.mergedInto, e.id) AS head", { ownerKey, id });
  const head = found.records[0]?.get('head');
  return typeof head === 'string' ? head : null;
}

/** For each given head: the head followed by its members (by id). Unknown ids map to themselves alone. */
export async function membersOf(tx: Runner, ownerKey: string, heads: string[]): Promise<Map<string, string[]>> {
  const result = new Map(heads.map(head => [head, [head]]));
  if (!heads.length) return result;
  const rows = await tx.run('MATCH (m:OverlayEntity {ownerKey:$ownerKey}) WHERE m.mergedInto IN $heads RETURN m.mergedInto AS head, m.id AS id ORDER BY m.id', { ownerKey, heads });
  for (const row of rows.records) result.get(String(row.get('head')))?.push(String(row.get('id')));
  return result;
}

/** id -> head for the given ids (ids of entities that are not merged map to themselves). */
export async function headsOf(tx: Runner, ownerKey: string, ids: string[]): Promise<Map<string, string>> {
  const result = new Map(ids.map(id => [id, id]));
  if (!ids.length) return result;
  const rows = await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE e.id IN $ids AND e.mergedInto IS NOT NULL RETURN e.id AS id, e.mergedInto AS head', { ownerKey, ids: [...new Set(ids)] });
  for (const row of rows.records) result.set(String(row.get('id')), String(row.get('head')));
  return result;
}

/** Member summaries (head first) for heads that have members; heads without members are absent. */
export async function memberSummaries(tx: Runner, ownerKey: string, heads: string[]): Promise<Map<string, Member[]>> {
  const result = new Map<string, Member[]>();
  if (!heads.length) return result;
  const rows = await tx.run(`MATCH (m:OverlayEntity {ownerKey:$ownerKey}) WHERE m.mergedInto IN $heads
    MATCH (h:OverlayEntity {ownerKey:$ownerKey, id:m.mergedInto})
    RETURN h.id AS head, h.name AS headName, m.id AS id, m.name AS name, m.mergeEventId AS eventId ORDER BY m.id`, { ownerKey, heads });
  for (const row of rows.records) {
    const head = String(row.get('head'));
    if (!result.has(head)) result.set(head, [{ id: head, name: String(row.get('headName')), mergeEventId: null }]);
    result.get(head)!.push({ id: String(row.get('id')), name: String(row.get('name')), mergeEventId: (row.get('eventId') as string | null) ?? null });
  }
  return result;
}

interface Stats { id: string; head: string; kind: string; createdAt: string; refs: string[]; stateful: boolean; notes: number; asks: number; mergedInto: string | null; mergeEventId: string | null }
async function statsOf(tx: Runner, ownerKey: string, ids: string[]): Promise<Stats[]> {
  const rows = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE e.id IN $ids
    RETURN e.id AS id, coalesce(e.mergedInto, e.id) AS head, e.kind AS kind, e.createdAt AS createdAt, e.mergedInto AS mergedInto, e.mergeEventId AS mergeEventId,
      [(r:OverlayRef {ownerKey:$ownerKey})-[:REF_OF]->(e) | r.ref] AS refs,
      (e.peopleState IS NOT NULL OR coalesce(e.important, false) OR e.cadenceDays IS NOT NULL OR e.intervalDays IS NOT NULL OR e.explicitNextDueAt IS NOT NULL OR e.lastContactAt IS NOT NULL) AS stateful,
      COUNT { (n:OverlayNote {ownerKey:$ownerKey, entityId:e.id}) } AS notes,
      COUNT { (a:OverlayEntity {ownerKey:$ownerKey, kind:'ask'}) WHERE coalesce(a.askAuthorId, a.askerId) = e.id OR a.carrierId = e.id } AS asks`, { ownerKey, ids });
  return rows.records.map(row => ({
    id: String(row.get('id')), head: String(row.get('head')), kind: String(row.get('kind')), createdAt: String(row.get('createdAt') ?? ''),
    refs: (row.get('refs') as string[]) ?? [], stateful: row.get('stateful') === true, notes: num(row.get('notes')), asks: num(row.get('asks')),
    mergedInto: (row.get('mergedInto') as string | null) ?? null, mergeEventId: (row.get('mergeEventId') as string | null) ?? null,
  }));
}
const num = (value: unknown): number => value === null || value === undefined ? 0 : typeof value === 'number' ? value : typeof (value as { toNumber?: () => number }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : Number(value);
const APP_REF = /^(unlinked:person:|linkedin:in:)/;

/**
 * The member that should carry the person: People state or catch-up settings,
 * then an app ref (Unlinked, LinkedIn), then asks, then most notes, then the
 * oldest, then the smallest id (deterministic).
 */
function pickHead(candidates: Stats[], cluster: Stats[]): string {
  const score = (s: Stats) => {
    const group = cluster.filter(x => x.head === s.id || x.id === s.id);
    return [group.some(x => x.stateful) ? 1 : 0, group.some(x => x.refs.some(r => APP_REF.test(r))) ? 1 : 0, group.reduce((n, x) => n + x.asks, 0) ? 1 : 0, group.reduce((n, x) => n + x.notes, 0)];
  };
  return [...candidates].sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i]! - sa[i]!;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0]!.id;
}

const fingerprint = (value: unknown) => createHash('sha256').update(stableJSON(value)).digest('hex');

async function replay(tx: Runner, ownerKey: string, operationId: string, print: string): Promise<MergeEvent | null> {
  const found = await tx.run('MATCH (m:OverlayMergeEvent {ownerKey:$ownerKey, operationId:$operationId}) RETURN properties(m) AS m', { ownerKey, operationId });
  const row = found.records[0]?.get('m') as Record<string, unknown> | undefined;
  if (!row) return null;
  if (row.fingerprint !== print) return fail(409, 'operation_id_reused');
  return eventFrom(row);
}

async function cannotLink(tx: Runner, ownerKey: string, groups: string[][]): Promise<boolean> {
  const rows = await tx.run(`MATCH (d:OverlayIdentityDecision {ownerKey:$ownerKey, verdict:'different'}) WHERE d.revokedAt IS NULL RETURN d.anchorsA AS a, d.anchorsB AS b`, { ownerKey });
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => group.forEach(id => groupOf.set(id, index)));
  for (const row of rows.records) {
    const a = ((row.get('a') as string[]) ?? []).filter(id => groupOf.has(id)), b = ((row.get('b') as string[]) ?? []).filter(id => groupOf.has(id));
    // A decision only forbids joining what is currently apart: both sides already in one person is a split's own history.
    if (a.some(x => b.some(y => groupOf.get(x) !== groupOf.get(y)))) return true;
  }
  return false;
}

async function writeEvent(tx: Runner, ownerKey: string, event: MergeEvent, extra: Record<string, unknown> = {}): Promise<void> {
  await tx.run(`MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) SET c.mergeSequence=coalesce(c.mergeSequence, 0)+1
    CREATE (m:OverlayMergeEvent {id:$id, ownerKey:$ownerKey}) SET m += $props, m.sequence=c.mergeSequence`, { id: event.id, ownerKey, props: {
    kind: event.kind, headId: event.headId, memberIds: event.memberIds, changes: JSON.stringify(event.changes), rule: event.rule, evidence: event.evidence,
    participantIds: event.memberIds, batchId: event.batchId, operationId: event.operationId, revertOf: event.revertOf, actor: event.actor, actorId: event.actorId, at: event.at,
    ...(event.result ? { result: JSON.stringify(event.result) } : {}), ...extra,
  } });
}

async function applyChanges(tx: Runner, ownerKey: string, changes: PointerChange[], now: string): Promise<void> {
  await tx.run(`UNWIND $changes AS c MATCH (e:OverlayEntity {ownerKey:$ownerKey, id:c.id}) SET e.mergedInto = c.mergedInto, e.mergeEventId = c.mergeEventId, e.mergeUpdatedAt = $now`,
    { ownerKey, now, changes: changes.map(c => ({ id: c.id, mergedInto: c.after.mergedInto, mergeEventId: c.after.mergeEventId })) });
}

/**
 * Merge two or more of the owner's people into one. Idempotent on
 * `operationId` (same request: the original event; different request: 409
 * `operation_id_reused`). Ids already in one person answer `merged: false`.
 */
export async function mergeIn(tx: Runner, ownerKey: string, input: MergeInput, by: By): Promise<{ merged: boolean; replayed: boolean; headId: string; memberIds: string[]; event: MergeEvent | null }> {
  await lockOwner(tx, ownerKey);
  const print = fingerprint({ kind: 'merge', ids: [...input.ids].sort(), headId: input.headId, rule: input.rule, evidence: input.evidence, batchId: input.batchId, actorId: by.actorId });
  const previous = await replay(tx, ownerKey, input.operationId, print);
  if (previous) return { merged: previous.kind !== 'noop', replayed: true, headId: previous.headId, memberIds: previous.memberIds, event: previous.kind === 'noop' ? null : previous };
  const given = await statsOf(tx, ownerKey, input.ids);
  if (given.length !== input.ids.length) return fail(404, 'not_found');
  if (given.some(s => s.kind !== 'person')) return fail(400, 'merge_kind');
  const heads = [...new Set(given.map(s => s.head))].sort();
  // Lock the heads: note, link and People writes lock the entity they resolve to.
  await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE e.id IN $heads SET e._lock = true REMOVE e._lock', { ownerKey, heads });
  const clusterIds = [...new Set([...(await membersOf(tx, ownerKey, heads)).values()].flat())];
  if (clusterIds.length > MERGE_LIMITS.clusterSize) return fail(409, 'merge_too_large');
  const cluster = await statsOf(tx, ownerKey, clusterIds);
  if (cluster.some(s => s.kind !== 'person')) return fail(400, 'merge_kind');
  // OpenChat account cards keep their own identity in this slice.
  if (cluster.some(s => s.refs.some(ref => ref.startsWith('openchat:user:')))) return fail(409, 'merge_account');
  const stateful = cluster.filter(s => s.stateful);
  if (stateful.length > 1) return fail(409, 'merge_state_conflict');
  if (await cannotLink(tx, ownerKey, heads.map(head => cluster.filter(s => s.head === head).map(s => s.id)))) return fail(409, 'cannot_link');
  const headStats = cluster.filter(s => heads.includes(s.id));
  let head: string;
  if (input.headId !== null) {
    head = given.find(s => s.id === input.headId)!.head;
  } else head = pickHead(headStats, cluster);
  if (stateful.length && head !== stateful[0]!.head) return fail(409, 'merge_state_conflict');
  const eventId = nanoid(), now = new Date().toISOString();
  if (heads.length < 2) {
    await writeEvent(tx, ownerKey, { id: eventId, kind: 'noop', headId: head, memberIds: clusterIds.sort(), changes: [], rule: input.rule, evidence: input.evidence,
      batchId: input.batchId, operationId: input.operationId, revertOf: null, actor: by.author, actorId: by.actorId, at: now, revertedAt: null, revertedBy: null }, { fingerprint: print, via: by.source });
    return { merged: false, replayed: false, headId: head, memberIds: clusterIds, event: null };
  }
  const changes: PointerChange[] = cluster.filter(s => s.id !== head && s.head !== head).sort((a, b) => a.id < b.id ? -1 : 1)
    .map(s => ({ id: s.id, before: { mergedInto: s.mergedInto, mergeEventId: s.mergeEventId }, after: { mergedInto: head, mergeEventId: eventId } }));
  await applyChanges(tx, ownerKey, changes, now);
  const event: MergeEvent = { id: eventId, kind: 'merge', headId: head, memberIds: clusterIds.sort(), changes, rule: input.rule, evidence: input.evidence, batchId: input.batchId,
    operationId: input.operationId, revertOf: null, actor: by.author, actorId: by.actorId, at: now, revertedAt: null, revertedBy: null };
  await writeEvent(tx, ownerKey, event, { fingerprint: print, requestedIds: input.ids, via: by.source });
  return { merged: true, replayed: false, headId: head, memberIds: event.memberIds, event };
}

/**
 * Take one record out of its person. A member simply loses its pointer; when
 * the head is split off, the best remaining member becomes the head. Notes,
 * links and source cards stay on the entity they were written on. Unless
 * `decision: false`, a "different" decision keeps a later merge from joining
 * them again.
 */
export async function splitIn(tx: Runner, ownerKey: string, input: SplitInput, by: By): Promise<{ replayed: boolean; id: string; headId: string; event: MergeEvent }> {
  await lockOwner(tx, ownerKey);
  const print = fingerprint({ kind: 'split', id: input.id, reason: input.reason, decision: input.decision, actorId: by.actorId });
  const previous = await replay(tx, ownerKey, input.operationId, print);
  if (previous) return { replayed: true, id: input.id, headId: previous.headId, event: previous };
  const head = await headOf(tx, ownerKey, input.id);
  if (head === null) return fail(404, 'not_found');
  await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey, id:$head}) SET e._lock = true REMOVE e._lock', { ownerKey, head });
  const clusterIds = (await membersOf(tx, ownerKey, [head])).get(head)!;
  if (clusterIds.length < 2) return fail(409, 'not_merged');
  const cluster = await statsOf(tx, ownerKey, clusterIds);
  const rest = cluster.filter(s => s.id !== input.id);
  const eventId = nanoid(), now = new Date().toISOString();
  const changes: PointerChange[] = [];
  let remainingHead = head;
  if (input.id !== head) {
    const s = cluster.find(x => x.id === input.id)!;
    changes.push({ id: s.id, before: { mergedInto: s.mergedInto, mergeEventId: s.mergeEventId }, after: { mergedInto: null, mergeEventId: null } });
  } else {
    remainingHead = pickHead(rest.map(s => ({ ...s, head: s.id })), rest.map(s => ({ ...s, head: s.id })));
    for (const s of rest.sort((a, b) => a.id < b.id ? -1 : 1)) changes.push(s.id === remainingHead
      ? { id: s.id, before: { mergedInto: s.mergedInto, mergeEventId: s.mergeEventId }, after: { mergedInto: null, mergeEventId: null } }
      : { id: s.id, before: { mergedInto: s.mergedInto, mergeEventId: s.mergeEventId }, after: { mergedInto: remainingHead, mergeEventId: eventId } });
  }
  await applyChanges(tx, ownerKey, changes, now);
  const event: MergeEvent = { id: eventId, kind: 'split', headId: remainingHead, memberIds: clusterIds.slice().sort(), changes, rule: null, evidence: input.reason ? [input.reason] : [],
    batchId: null, operationId: input.operationId, revertOf: null, actor: by.author, actorId: by.actorId, at: now, revertedAt: null, revertedBy: null };
  await writeEvent(tx, ownerKey, event, { fingerprint: print, splitId: input.id, via: by.source });
  if (input.decision) await tx.run(`CREATE (d:OverlayIdentityDecision {id:$id, ownerKey:$ownerKey, verdict:'different', anchorsA:$a, anchorsB:$b, eventId:$eventId, actor:$actor, actorId:$actorId, at:$now})`,
    { id: nanoid(), ownerKey, a: [input.id], b: rest.map(s => s.id).sort(), eventId, actor: by.author, actorId: by.actorId, now });
  return { replayed: false, id: input.id, headId: remainingHead, event };
}

/**
 * Undo merge events: one by id, or every merge of a batch (newest first).
 * An event is reverted only while every pointer it set is unchanged; anything
 * later that depends on it answers 409 `merge_superseded` and nothing in the
 * request is changed. Already reverted events are skipped, so a retry is safe.
 */
export async function revertIn(tx: Runner, ownerKey: string, input: RevertInput, by: By): Promise<{ reverted: string[]; skipped: string[] }> {
  await lockOwner(tx, ownerKey);
  const print = fingerprint({ kind: 'revert', eventId: input.eventId, batchId: input.batchId, actorId: by.actorId });
  if (input.operationId) {
    const previous = await replay(tx, ownerKey, input.operationId, print);
    if (previous) return previous.result!;
  }
  const rows = input.eventId !== null
    ? await tx.run('MATCH (m:OverlayMergeEvent {ownerKey:$ownerKey, id:$id}) RETURN properties(m) AS m', { ownerKey, id: input.eventId })
    : await tx.run("MATCH (m:OverlayMergeEvent {ownerKey:$ownerKey, batchId:$batchId, kind:'merge'}) RETURN properties(m) AS m ORDER BY coalesce(m.sequence, 0) DESC, m.at DESC, m.id DESC LIMIT $limit",
      { ownerKey, batchId: input.batchId, limit: neo4j.int(MERGE_LIMITS.batchRevert + 1) });
  if (input.eventId !== null && !rows.records.length) return fail(404, 'not_found');
  if (rows.records.length > MERGE_LIMITS.batchRevert) return fail(413, 'revert_too_large');
  const events = rows.records.map(row => eventFrom(row.get('m') as Record<string, unknown>));
  if (events.some(event => event.kind !== 'merge')) return fail(400, 'revert_kind');
  const reverted: string[] = [], skipped: string[] = [], now = new Date().toISOString();
  for (const event of events) {
    if (event.revertedAt) { skipped.push(event.id); continue; }
    const dependencies = await tx.run(`MATCH (original:OverlayMergeEvent {ownerKey:$ownerKey, id:$id})
      MATCH (later:OverlayMergeEvent {ownerKey:$ownerKey})
      WHERE later.id <> original.id AND later.kind IN ['merge', 'split'] AND later.revertedAt IS NULL
        AND (CASE WHEN original.sequence IS NOT NULL AND later.sequence IS NOT NULL THEN later.sequence > original.sequence ELSE later.at >= original.at END)
        AND any(id IN coalesce(later.participantIds, later.memberIds) WHERE id IN coalesce(original.participantIds, original.memberIds))
      RETURN later.id AS id LIMIT 1`, { ownerKey, id: event.id });
    if (dependencies.records.length) return fail(409, 'merge_superseded', { eventId: event.id, dependencyId: dependencies.records[0]!.get('id') });
    const current = await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE e.id IN $ids RETURN e.id AS id, e.mergedInto AS mergedInto, e.mergeEventId AS mergeEventId',
      { ownerKey, ids: event.changes.map(c => c.id) });
    const now_ = new Map(current.records.map(row => [String(row.get('id')), { mergedInto: (row.get('mergedInto') as string | null) ?? null, mergeEventId: (row.get('mergeEventId') as string | null) ?? null }]));
    const moved = event.changes.filter(c => { const x = now_.get(c.id); return !x || x.mergedInto !== c.after.mergedInto || x.mergeEventId !== c.after.mergeEventId; }).map(c => c.id);
    if (moved.length) return fail(409, 'merge_superseded', { eventId: event.id, ids: moved });
    const changes = event.changes.map(c => ({ id: c.id, before: c.after, after: c.before }));
    await applyChanges(tx, ownerKey, changes, now);
    const revert: MergeEvent = { id: nanoid(), kind: 'revert', headId: event.headId, memberIds: event.memberIds, changes, rule: event.rule, evidence: [], batchId: event.batchId,
      operationId: null, revertOf: event.id, actor: by.author, actorId: by.actorId, at: now, revertedAt: null, revertedBy: null };
    await writeEvent(tx, ownerKey, revert, { via: by.source });
    await tx.run('MATCH (m:OverlayMergeEvent {ownerKey:$ownerKey, id:$id}) SET m.revertedAt = $now, m.revertedBy = $revertId', { ownerKey, id: event.id, now, revertId: revert.id });
    reverted.push(event.id);
  }
  const result = { reverted, skipped };
  if (input.operationId) await writeEvent(tx, ownerKey, { id: nanoid(), kind: 'revert-receipt', headId: events[0]?.headId ?? '',
    memberIds: [...new Set(events.flatMap(event => event.memberIds))].sort(), changes: [], rule: null, evidence: [], batchId: input.batchId,
    operationId: input.operationId, revertOf: input.eventId, actor: by.author, actorId: by.actorId, at: now, revertedAt: null, revertedBy: null, result }, { fingerprint: print, via: by.source });
  return result;
}

/** The owner's merge events, newest first: all, one batch's, or those touching one person (any member id). */
export async function listMergeEventsIn(tx: Runner, ownerKey: string, filter: { batchId?: unknown; entityId?: unknown; limit?: unknown }): Promise<{ events: MergeEvent[]; truncated: boolean }> {
  const batchId = filter.batchId === undefined || filter.batchId === '' ? null : typeof filter.batchId === 'string' && BATCH.test(filter.batchId) ? filter.batchId : fail(400, 'invalid_batch');
  const entityId = filter.entityId === undefined || filter.entityId === '' ? null : isId(filter.entityId) ? filter.entityId : fail(400, 'invalid_entity');
  const parsed = filter.limit === undefined ? 100 : typeof filter.limit === 'number' ? filter.limit : typeof filter.limit === 'string' && /^\d{1,4}$/.test(filter.limit) ? Number(filter.limit) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return fail(400, 'invalid_limit');
  let ids: string[] | null = null;
  if (entityId !== null) {
    const head = await headOf(tx, ownerKey, entityId);
    if (head === null) return fail(404, 'not_found');
    ids = (await membersOf(tx, ownerKey, [head])).get(head)!;
  }
  const rows = await tx.run(`MATCH (m:OverlayMergeEvent {ownerKey:$ownerKey}) WHERE ($batchId IS NULL OR m.batchId = $batchId) AND ($ids IS NULL OR any(id IN m.memberIds WHERE id IN $ids))
    RETURN properties(m) AS m ORDER BY coalesce(m.sequence, 0) DESC, m.at DESC, m.id DESC LIMIT $limit`, { ownerKey, batchId, ids, limit: neo4j.int(parsed + 1) });
  return { events: rows.records.slice(0, parsed).map(row => eventFrom(row.get('m') as Record<string, unknown>)), truncated: rows.records.length > parsed };
}

function eventFrom(row: Record<string, unknown>): MergeEvent {
  const text = (value: unknown) => typeof value === 'string' ? value : null;
  return {
    id: String(row.id), kind: row.kind as MergeEvent['kind'], headId: String(row.headId), memberIds: (row.memberIds as string[]) ?? [],
    changes: typeof row.changes === 'string' ? JSON.parse(row.changes) as PointerChange[] : [], rule: text(row.rule), evidence: (row.evidence as string[]) ?? [],
    batchId: text(row.batchId), operationId: text(row.operationId), revertOf: text(row.revertOf), actor: text(row.actor), actorId: text(row.actorId), at: String(row.at),
    revertedAt: text(row.revertedAt), revertedBy: text(row.revertedBy),
    ...(typeof row.result === 'string' ? { result: JSON.parse(row.result) as { reverted: string[]; skipped: string[] } } : {}),
  };
}

/** Export rows: every merge event and identity decision, as stored. */
export async function exportMergesIn(tx: Runner, ownerKey: string): Promise<{ mergeEvents: unknown[]; identityDecisions: unknown[] }> {
  const events = await tx.run('MATCH (m:OverlayMergeEvent {ownerKey:$ownerKey}) RETURN properties(m) AS row ORDER BY m.at, m.id', { ownerKey });
  const decisions = await tx.run('MATCH (d:OverlayIdentityDecision {ownerKey:$ownerKey}) RETURN properties(d) AS row ORDER BY d.at, d.id', { ownerKey });
  return { mergeEvents: events.records.map(r => r.get('row')), identityDecisions: decisions.records.map(r => r.get('row')) };
}
