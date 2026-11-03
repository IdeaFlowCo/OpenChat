/**
 * One-time move of asks kept elsewhere into the Noos overlay's `ask` kind
 * (OpenChat-2fsy.1, 2026-11-03), so the overlay is their one home:
 *
 * 1. `[friend-ask v1]` overlay notes (the friends'-asks monitor's interim
 *    format) become asks by the person the note is on. The notes stay: they
 *    are removed by hand only after the migration has been checked.
 * 2. OpenChat's own `OpenChatPrivateAsk` records (standing asks from note
 *    reviews) become asks by their subject; each keeps its node, marked
 *    `migratedTo`, and the review ledgers that created them are re-pointed so
 *    undo keeps working.
 *
 * Idempotent: an ask is one per asker and text, and migrated records are
 * skipped, so a second run changes nothing. Dry-run unless `apply` is set.
 * Every write goes through the vendored Noos store's transaction forms.
 */
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { ASK_HORIZONS, ASK_STATUSES, ASKER_KINDS, LIMITS, OverlayError, parseAskInput, readProvenance } from './overlay/contract.js';
import type { AskHorizon, AskStatus, EntityKind, Provenance } from './overlay/contract.js';
import { addLinkIn, OverlayStore, saveAskIn, updateAskIn } from './overlay/store.js';

export const FRIEND_ASK_PREFIX = '[friend-ask v1]';
export interface ParsedFriendAsk { text: string; horizon: AskHorizon; recheckAfter: string | null; status: AskStatus; label: string | null; seenAt: string | null; url: string | null }

const URL_PATTERN = /https?:\/\/[^\s)>\]]+/;
const DATE = /\d{4}-\d{2}-\d{2}/;
const cut = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
function horizonOf(value: string | undefined): AskHorizon {
  const text = (value ?? '').toLowerCase();
  // "semi-evergreen" is a long-lived ask with a fresher part: medium.
  if (/semi-?evergreen/.test(text)) return 'medium';
  return ASK_HORIZONS.find(horizon => new RegExp(`\\b${horizon}\\b`).test(text)) ?? 'medium';
}

/**
 * The two shapes `[friend-ask v1]` notes were written in: a header line
 * followed by `key: value` lines (`ask:`, `source:`, `staleness:`,
 * `status:`), or one line `[friend-ask v1] staleness=<horizon> · <text>`.
 * Null when the note is not a friend ask or has no ask text.
 */
export function parseFriendAskNote(note: string): ParsedFriendAsk | null {
  if (!note.startsWith(FRIEND_ASK_PREFIX)) return null;
  const body = note.slice(FRIEND_ASK_PREFIX.length);
  const url = note.match(URL_PATTERN)?.[0] ?? null;
  const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^([a-z][a-z _-]{0,40}):\s*(.+)$/i);
    if (match) fields.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
  }
  const source = fields.get('source') ?? null;
  let text: string | undefined = fields.get('ask'), staleness = fields.get('staleness');
  if (!text) {
    // One line: key=value pairs, then " · " and the ask.
    const [head, ...rest] = (lines[0] ?? '').split(' · ');
    for (const [, key, value] of head!.matchAll(/([a-z_]+)=(\S+)/gi)) fields.set(key!.toLowerCase(), value!);
    staleness = fields.get('staleness') ?? staleness;
    text = (rest.length ? rest.join(' · ') : head!.replace(/([a-z_]+)=(\S+)/gi, '')).trim();
    if (lines.length > 1) text = [text, ...lines.slice(1)].join(' ');
  }
  if (!text) return null;
  const status = fields.get('status')?.toLowerCase().match(/^[a-z]+/)?.[0];
  const recheck = (staleness ?? '').match(new RegExp(`recheck(?: after)?\\s*(${DATE.source})`, 'i'))?.[1] ?? fields.get('recheck')?.match(DATE)?.[0] ?? null;
  return {
    text: cut(text.replace(/\s+/g, ' '), LIMITS.askLength), horizon: horizonOf(staleness), recheckAfter: recheck,
    status: ASK_STATUSES.includes(status as AskStatus) ? status as AskStatus : 'open',
    label: source ? cut(source.replace(/\s+/g, ' '), LIMITS.labelLength) : 'Friend ask note', seenAt: source?.match(new RegExp(`seen\\s+(${DATE.source})`, 'i'))?.[1] ?? null,
    url: url && url.length <= LIMITS.urlLength ? url : null,
  };
}

const LEGACY_STATUS: Record<string, AskStatus> = { active: 'open', paused: 'stale', closed: 'withdrawn' };
export interface MigrationReport {
  apply: boolean;
  friendAskNotes: { seen: number; created: number; existing: number; skipped: Array<{ noteId: string; reason: string }> };
  legacyAsks: { seen: number; created: number; existing: number; skipped: Array<{ id: string; reason: string }>; reviewsRepointed: number };
  created: Array<{ askId: string; from: string }>;
}

/** Move friend-ask notes and legacy OpenChat asks into overlay asks. Read-only unless `apply`. */
export async function migrateAsksToOverlay(driver: Driver, database: string, options: { apply: boolean }): Promise<MigrationReport> {
  const report: MigrationReport = {
    apply: options.apply, created: [],
    friendAskNotes: { seen: 0, created: 0, existing: 0, skipped: [] },
    legacyAsks: { seen: 0, created: 0, existing: 0, skipped: [], reviewsRepointed: 0 },
  };
  await new OverlayStore(driver, database).initialize();
  const session = driver.session({ database });
  try {
    const notes = (await session.run(`MATCH (n:OverlayNote)-[:NOTE_ABOUT]->(e:OverlayEntity) WHERE n.text STARTS WITH $prefix AND n.ownerKey = e.ownerKey
      RETURN n.id AS id, n.ownerKey AS ownerKey, n.text AS text, n.author AS author, n.source AS source, n.assertion AS assertion, e.id AS entityId, e.kind AS kind
      ORDER BY n.createdAt`, { prefix: FRIEND_ASK_PREFIX })).records;
    for (const record of notes) {
      report.friendAskNotes.seen++;
      const noteId = String(record.get('id')), ownerKey = String(record.get('ownerKey')), entityId = String(record.get('entityId'));
      const parsed = parseFriendAskNote(String(record.get('text')));
      if (!parsed) { report.friendAskNotes.skipped.push({ noteId, reason: 'no ask text' }); continue; }
      try {
      if (!ASKER_KINDS.includes(record.get('kind') as EntityKind)) { report.friendAskNotes.skipped.push({ noteId, reason: `note is on a ${String(record.get('kind'))}, which cannot ask` }); continue; }
      const stored = readProvenance({ author: record.get('author'), source: record.get('source'), assertion: record.get('assertion') });
      const by: Provenance = { author: stored.author ?? 'owner', source: stored.source ?? 'app', assertion: stored.assertion ?? 'stated' };
      const input = parseAskInput({ text: parsed.text, author: { id: entityId }, horizon: parsed.horizon, recheckAfter: parsed.recheckAfter, status: parsed.status,
        evidence: { label: parsed.label, seenAt: parsed.seenAt, url: parsed.url, noteId } });
      // A note already migrated (even if the owner has since edited that ask's text) is never migrated again.
      const migrated = async (tx: Pick<ManagedTransaction, 'run'>) => (await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey, kind: 'ask', askAuthorId: $entityId}) WHERE a.evidenceNoteId = $noteId RETURN a.id AS id`, { ownerKey, entityId, noteId })).records.length > 0;
      if (!options.apply) {
        if (await session.executeRead(migrated)) report.friendAskNotes.existing++; else report.friendAskNotes.created++;
        continue;
      }
      const outcome = await session.executeWrite(async tx => {
        if (await migrated(tx)) return null;
        const saved = await saveAskIn(tx, ownerKey, input, by);
        if (!saved.created) return null;
        // An asker the monitor linked to a project tracking its asks: link the ask there too.
        const trackers = await tx.run(`MATCH (:OverlayEntity {id: $entityId, ownerKey: $ownerKey})-[l:OVERLAY_LINK]->(p:OverlayEntity {ownerKey: $ownerKey, kind: 'project'})
          WHERE l.ownerKey = $ownerKey AND l.relation CONTAINS 'ask' RETURN DISTINCT p.id AS id`, { entityId, ownerKey });
        for (const tracker of trackers.records) await addLinkIn(tx, ownerKey, saved.ask.id, 'tracked in', String(tracker.get('id')), by);
        return saved.ask.id;
      });
      // Counted after the commit, so a retried transaction never counts twice.
      if (outcome) { report.friendAskNotes.created++; report.created.push({ askId: outcome, from: `note:${noteId}` }); } else report.friendAskNotes.existing++;
      } catch (error) {
        // One bad record never stops the rest; it is reported (code only, never text) and a re-run retries it.
        report.friendAskNotes.skipped.push({ noteId, reason: `refused: ${error instanceof OverlayError ? error.code : 'unexpected error'}` });
      }
    }

    const legacy = (await session.run(`MATCH (a:OpenChatPrivateAsk) WHERE a.migratedTo IS NULL
      OPTIONAL MATCH (e:OverlayEntity {id: a.entityId, ownerKey: a.ownerKey})
      OPTIONAL MATCH (n:OverlayNote {id: a.sourceNoteId, ownerKey: a.ownerKey})
      RETURN a { .id, .ownerKey, .entityId, .text, .status, .revision, .reviewId, .createdAt, .sourceNoteId } AS ask, e.kind AS kind, n IS NOT NULL AS noteExists ORDER BY a.createdAt`)).records;
    for (const record of legacy) {
      report.legacyAsks.seen++;
      const ask = record.get('ask') as { id: string; ownerKey: string; entityId: string; text: string; status?: string; revision?: unknown; reviewId?: string; createdAt?: string; sourceNoteId?: string };
      const kind = record.get('kind') as string | null;
      if (!kind) { report.legacyAsks.skipped.push({ id: ask.id, reason: 'its subject no longer exists' }); continue; }
      try {
      const asksItself = ASKER_KINDS.includes(kind as EntityKind), status = LEGACY_STATUS[ask.status ?? 'active'] ?? 'open';
      const input = parseAskInput({ text: cut(String(ask.text ?? '').replace(/\s+/g, ' ').trim() || '(empty)', LIMITS.askLength), author: asksItself ? { id: ask.entityId } : 'self', status,
        evidence: { label: 'Private note review', seenAt: typeof ask.createdAt === 'string' ? ask.createdAt.slice(0, 10) : null, noteId: record.get('noteExists') ? ask.sourceNoteId ?? null : null } });
      if (!options.apply) { report.legacyAsks.created++; continue; }
      const outcome = await session.executeWrite(async tx => {
        const by: Provenance = { author: 'owner', source: 'suggestion', assertion: 'inferred' };
        const saved = await saveAskIn(tx, ask.ownerKey, input, by);
        // A topic's ask is the owner's own, linked to the topic (also when that ask already existed, from another card).
        if (!asksItself) await addLinkIn(tx, ask.ownerKey, saved.ask.id, 'is about', ask.entityId, by);
        // An ask the owner had edited stays protected from its review's undo.
        if (saved.created && Number(ask.revision ?? 0) > 0) await updateAskIn(tx, ask.ownerKey, saved.ask.id, { status }, { author: 'owner', source: 'app', assertion: 'stated' });
        await tx.run('MATCH (a:OpenChatPrivateAsk {id: $id, ownerKey: $ownerKey}) SET a.migratedTo = $askId', { id: ask.id, ownerKey: ask.ownerKey, askId: saved.ask.id });
        let repointed = 0;
        if (ask.reviewId) {
          const reviews = await tx.run('MATCH (r:OpenChatNoteReview {id: $reviewId, ownerKey: $ownerKey}) RETURN r.payload AS payload', { reviewId: ask.reviewId, ownerKey: ask.ownerKey });
          for (const row of reviews.records) {
            const payload = JSON.parse(String(row.get('payload'))) as { createdRecords?: Array<{ id: string; kind: string }> };
            const before = JSON.stringify(payload.createdRecords ?? []);
            // Undo removes only what the review created: an ask that already existed leaves its ledger.
            payload.createdRecords = (payload.createdRecords ?? []).flatMap(created => created.kind !== 'ask' || created.id !== ask.id ? [created] : saved.created ? [{ ...created, id: saved.ask.id }] : []);
            if (JSON.stringify(payload.createdRecords) !== before) {
              await tx.run('MATCH (r:OpenChatNoteReview {id: $reviewId, ownerKey: $ownerKey}) SET r.payload = $payload', { reviewId: ask.reviewId, ownerKey: ask.ownerKey, payload: JSON.stringify(payload) });
              repointed++;
            }
          }
        }
        return { askId: saved.ask.id, created: saved.created, repointed };
      });
      report.legacyAsks.reviewsRepointed += outcome.repointed;
      if (outcome.created) { report.legacyAsks.created++; report.created.push({ askId: outcome.askId, from: `OpenChatPrivateAsk:${ask.id}` }); } else report.legacyAsks.existing++;
      } catch (error) {
        report.legacyAsks.skipped.push({ id: ask.id, reason: `refused: ${error instanceof OverlayError ? error.code : 'unexpected error'}` });
      }
    }
  } finally { await session.close(); }
  return report;
}
