/**
 * Imported chat mirrors (OpenChat-061g) — an owner's private, read-only copy
 * of a chat from another network. See docs/imported-chat-mirrors.md.
 *
 * Everything lives under its own `OpenChatImported*` labels, never as
 * `Conversation`/`Message`/`User` nodes, so sockets, push, unread, search,
 * the OpenChat Agent, Context, matching and discovery cannot reach it. Every
 * node carries `ownerUserId` and every query is anchored on it. Imported
 * people are participants with a source key, never accounts. Linking a
 * participant to an OpenChat account is deliberately not offered yet
 * (docs/imported-chat-mirrors.md, "Later: account claims").
 */

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import { getDriver } from '../db.js';

export class ImportedChatError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}
const fail = (status: number, message: string, details?: Record<string, unknown>): never => { throw new ImportedChatError(status, message, details); };

export const IMPORT_LIMITS = { messages: 5000, participants: 2000, asks: 1000, factsPerParticipant: 50, key: 200, text: 20_000, askText: 1000, factText: 1000, name: 120, title: 200, note: 500, method: 80, sources: 50, pageSize: 200 } as const;
export const MESSAGE_KINDS = ['text', 'media', 'system', 'deleted'] as const;
/** `self_stated`: the person gave this name in their own message (cite it in nameSourceMessageIds). */
export const NAME_SOURCES = ['contact', 'push_name', 'profile', 'self_stated', 'owner', 'unknown'] as const;
export const MEMBERSHIPS = ['current', 'former', 'unknown'] as const;
export type Membership = typeof MEMBERSHIPS[number];
export const SOURCE_STATUSES = ['open', 'resolved', 'withdrawn', 'needs_review', 'unknown'] as const;
export const OWNER_STATUSES = ['open', 'resolved', 'withdrawn', 'needs_review'] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];
export type NameSource = typeof NAME_SOURCES[number];
export type SourceStatus = typeof SOURCE_STATUSES[number];
export type OwnerStatus = typeof OWNER_STATUSES[number];

// ── Payload ───────────────────────────────────────────────────────────────────

export interface ImportSource { network: string; accountKey: string; chatKey: string; chatType: 'group' | 'direct'; title: string }
/** How many rows the source held for this chat, whatever was imported: total, ordinary text messages, and everything else (media, system, calls…). */
export interface SourceRowCounts { total: number; text: number | null; nonText: number | null }
export interface ImportCoverage { asOf: string; method: string; earliestMessageAt: string | null; latestMessageAt: string | null; complete: boolean; note: string | null; sourceRowCounts: SourceRowCounts | null }
export interface ImportFact { factKey: string; text: string; sourceMessageIds: string[] }
export interface ImportParticipant { sourceKey: string; displayName: string | null; nameSource: NameSource; nameSourceMessageIds: string[]; membership: Membership | null; isOwner: boolean | null; profileFacts: ImportFact[] }
export interface ImportMessage { sourceMessageId: string; senderKey: string | null; sentAt: string; kind: MessageKind; text: string | null; mediaType: string | null; editedAt: string | null; replyToSourceMessageId: string | null }
export interface ImportAsk { askKey: string; subjectKey: string | null; subjectLabel: string | null; reporterKey: string; text: string; sourceMessageIds: string[]; sourceStatus: SourceStatus; statusSourceMessageIds: string[] }
export interface ImportPayload { source: ImportSource; coverage: ImportCoverage; participants: ImportParticipant[]; messages: ImportMessage[]; asks: ImportAsk[] }
export interface ValidationIssue { path: string; message: string }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const NETWORK = /^[a-z0-9_-]{1,32}$/;
// eslint-disable-next-line no-control-regex -- deliberate control-character strip
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Validates the whole payload, collecting every problem rather than the first. */
export function parseImportPayload(body: unknown): ImportPayload {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, message: string) => { if (issues.length < 200) issues.push({ path, message }); };
  const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const key = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > IMPORT_LIMITS.key || CONTROL.test(value)) { CONTROL.lastIndex = 0; issue(path, `must be a key of 1–${IMPORT_LIMITS.key} characters`); return ''; }
    return value;
  };
  const text = (value: unknown, path: string, max: number, required: boolean): string | null => {
    if (value === undefined || value === null) { if (required) issue(path, 'is required'); return null; }
    if (typeof value !== 'string') { issue(path, 'must be text'); return null; }
    const clean = value.replace(CONTROL, '').trim();
    if (!clean) { if (required) issue(path, 'is required'); return null; }
    if (clean.length > max) { issue(path, `is longer than ${max} characters`); return null; }
    return clean;
  };
  const time = (value: unknown, path: string, required: boolean): string | null => {
    if (value === undefined || value === null) { if (required) issue(path, 'is required'); return null; }
    const ms = typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) { issue(path, 'must be an ISO 8601 date-time with a time zone'); return null; }
    return new Date(ms).toISOString();
  };
  const ids = (value: unknown, path: string, required: boolean): string[] => {
    if (value === undefined || value === null) { if (required) issue(path, 'needs at least one source message'); return []; }
    if (!Array.isArray(value)) { issue(path, 'must be a list of source message ids'); return []; }
    if (required && value.length === 0) issue(path, 'needs at least one source message');
    if (value.length > IMPORT_LIMITS.sources) issue(path, `lists more than ${IMPORT_LIMITS.sources} messages`);
    return [...new Set(value.map((id, i) => key(id, `${path}[${i}]`)).filter(Boolean))];
  };
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], path: string, fallback?: T): T => {
    if (value === undefined && fallback) return fallback;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    issue(path, `must be one of ${allowed.join(', ')}`);
    return allowed[0];
  };
  const list = (value: unknown, path: string, max: number): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { issue(path, 'must be a list'); return []; }
    if (value.length > max) { issue(path, `has more than ${max} items; send several requests`); return []; }
    return value;
  };

  const root = obj(body);
  if (!root) fail(400, 'Import payload must be a JSON object', { errors: [{ path: '', message: 'must be an object' }] });
  if (root!.schemaVersion !== 1) issue('schemaVersion', 'must be 1');
  const s = obj(root!.source) ?? (issue('source', 'is required'), {});
  const network = typeof s.network === 'string' && NETWORK.test(s.network) ? s.network : (issue('source.network', 'must be a lowercase network id'), '');
  const source: ImportSource = {
    network,
    accountKey: key(s.accountKey, 'source.accountKey'),
    chatKey: key(s.chatKey, 'source.chatKey'),
    chatType: oneOf(s.chatType, ['group', 'direct'] as const, 'source.chatType'),
    title: text(s.title, 'source.title', IMPORT_LIMITS.title, true) ?? '',
  };
  const c = obj(root!.coverage) ?? (issue('coverage', 'is required'), {});
  if (typeof c.complete !== 'boolean') issue('coverage.complete', 'must be true or false');
  const coverage: ImportCoverage = {
    asOf: time(c.asOf, 'coverage.asOf', true) ?? '',
    method: text(c.method, 'coverage.method', IMPORT_LIMITS.method, true) ?? '',
    earliestMessageAt: time(c.earliestMessageAt, 'coverage.earliestMessageAt', false),
    latestMessageAt: time(c.latestMessageAt, 'coverage.latestMessageAt', false),
    complete: c.complete === true,
    note: text(c.note, 'coverage.note', IMPORT_LIMITS.note, false),
    sourceRowCounts: null,
  };
  if (c.sourceRowCounts !== undefined && c.sourceRowCounts !== null) {
    const rc = obj(c.sourceRowCounts) ?? (issue('coverage.sourceRowCounts', 'must be an object'), {});
    const count = (value: unknown, path: string, required: boolean): number | null => {
      if (value === undefined || value === null) { if (required) issue(path, 'is required'); return null; }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000_000) { issue(path, 'must be a whole number of rows'); return null; }
      return value;
    };
    const counts = { total: count(rc.total, 'coverage.sourceRowCounts.total', true) ?? 0, text: count(rc.text, 'coverage.sourceRowCounts.text', false), nonText: count(rc.nonText, 'coverage.sourceRowCounts.nonText', false) };
    if ((counts.text ?? 0) + (counts.nonText ?? 0) > counts.total) issue('coverage.sourceRowCounts', 'text and nonText add up to more than total');
    coverage.sourceRowCounts = counts;
  }

  const seen = (label: string) => { const set = new Set<string>(); return (value: string, path: string) => { if (value && set.has(value)) issue(path, `repeats ${label} ${JSON.stringify(value)}`); set.add(value); }; };
  const seenParticipant = seen('participant'), seenMessage = seen('message'), seenAsk = seen('ask');
  let owners = 0;
  const participants = list(root!.participants, 'participants', IMPORT_LIMITS.participants).map((raw, i): ImportParticipant => {
    const p = obj(raw) ?? (issue(`participants[${i}]`, 'must be an object'), {});
    const path = `participants[${i}]`;
    const sourceKey = key(p.sourceKey, `${path}.sourceKey`); seenParticipant(sourceKey, `${path}.sourceKey`);
    if (p.isOwner !== undefined && typeof p.isOwner !== 'boolean') issue(`${path}.isOwner`, 'must be true or false');
    if (p.isOwner === true) owners += 1;
    const nameSource = oneOf(p.nameSource, NAME_SOURCES, `${path}.nameSource`, 'unknown');
    const nameSourceMessageIds = ids(p.nameSourceMessageIds, `${path}.nameSourceMessageIds`, nameSource === 'self_stated');
    const seenFact = seen('fact');
    const profileFacts = list(p.profileFacts, `${path}.profileFacts`, IMPORT_LIMITS.factsPerParticipant).map((rawFact, j): ImportFact => {
      const f = obj(rawFact) ?? (issue(`${path}.profileFacts[${j}]`, 'must be an object'), {});
      const factPath = `${path}.profileFacts[${j}]`;
      const factText = text(f.text, `${factPath}.text`, IMPORT_LIMITS.factText, true) ?? '';
      const factKey = f.factKey === undefined ? `t:${createHash('sha256').update(factText.normalize('NFKC').toLowerCase()).digest('hex').slice(0, 24)}` : key(f.factKey, `${factPath}.factKey`);
      seenFact(factKey, `${factPath}.factKey`);
      return { factKey, text: factText, sourceMessageIds: ids(f.sourceMessageIds, `${factPath}.sourceMessageIds`, true) };
    });
    return {
      sourceKey,
      displayName: text(p.displayName, `${path}.displayName`, IMPORT_LIMITS.name, false),
      nameSource, nameSourceMessageIds,
      membership: p.membership === undefined || p.membership === null ? null : oneOf(p.membership, MEMBERSHIPS, `${path}.membership`),
      isOwner: typeof p.isOwner === 'boolean' ? p.isOwner : null,
      profileFacts,
    };
  });
  if (owners > 1) issue('participants', 'marks more than one participant as the owner');

  const messages = list(root!.messages, 'messages', IMPORT_LIMITS.messages).map((raw, i): ImportMessage => {
    const m = obj(raw) ?? (issue(`messages[${i}]`, 'must be an object'), {});
    const path = `messages[${i}]`;
    const sourceMessageId = key(m.sourceMessageId, `${path}.sourceMessageId`); seenMessage(sourceMessageId, `${path}.sourceMessageId`);
    const kind = oneOf(m.kind, MESSAGE_KINDS, `${path}.kind`);
    const senderKey = m.senderKey === null || m.senderKey === undefined ? null : key(m.senderKey, `${path}.senderKey`);
    if (!senderKey && kind !== 'system') issue(`${path}.senderKey`, 'is required except for system messages');
    const body = text(m.text, `${path}.text`, IMPORT_LIMITS.text, kind === 'text');
    if (kind === 'deleted' && body) issue(`${path}.text`, 'must be absent for a deleted message');
    const replyTo = m.replyToSourceMessageId === null || m.replyToSourceMessageId === undefined ? null : key(m.replyToSourceMessageId, `${path}.replyToSourceMessageId`);
    return {
      sourceMessageId, senderKey, kind,
      sentAt: time(m.sentAt, `${path}.sentAt`, true) ?? '',
      text: kind === 'deleted' ? null : body,
      mediaType: text(m.mediaType, `${path}.mediaType`, 40, false),
      editedAt: time(m.editedAt, `${path}.editedAt`, false),
      replyToSourceMessageId: replyTo,
    };
  });

  const asks = list(root!.asks, 'asks', IMPORT_LIMITS.asks).map((raw, i): ImportAsk => {
    const a = obj(raw) ?? (issue(`asks[${i}]`, 'must be an object'), {});
    const path = `asks[${i}]`;
    const askKey = key(a.askKey, `${path}.askKey`); seenAsk(askKey, `${path}.askKey`);
    const subjectKey = a.subjectKey === null || a.subjectKey === undefined ? null : key(a.subjectKey, `${path}.subjectKey`);
    const subjectLabel = text(a.subjectLabel, `${path}.subjectLabel`, IMPORT_LIMITS.name, false);
    if (!subjectKey && !subjectLabel) issue(`${path}.subjectKey`, 'name the participant whose need this is, or give subjectLabel when they are not in the chat');
    if (subjectKey && subjectLabel) issue(`${path}.subjectLabel`, 'is only for subjects who are not participants');
    return {
      askKey, subjectKey, subjectLabel,
      reporterKey: key(a.reporterKey, `${path}.reporterKey`),
      text: text(a.text, `${path}.text`, IMPORT_LIMITS.askText, true) ?? '',
      sourceMessageIds: ids(a.sourceMessageIds, `${path}.sourceMessageIds`, true),
      sourceStatus: oneOf(a.sourceStatus, SOURCE_STATUSES, `${path}.sourceStatus`, 'unknown'),
      statusSourceMessageIds: ids(a.statusSourceMessageIds, `${path}.statusSourceMessageIds`, false),
    };
  });

  if (issues.length) fail(400, 'The import was not saved. Fix these problems and send it again.', { errors: issues });
  return { source, coverage, participants, messages, asks };
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** Composite keys as single strings so Neo4j Community can enforce uniqueness. */
const compositeKey = (...parts: string[]) => JSON.stringify(parts);
const LABELS = ['OpenChatImportedChat', 'OpenChatImportedParticipant', 'OpenChatImportedMessage', 'OpenChatImportedAsk', 'OpenChatImportedFact'] as const;

export async function ensureImportedChatSchema(session: Session): Promise<void> {
  for (const label of LABELS) {
    await session.run(`CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT ${label.toLowerCase()}_import_key IF NOT EXISTS FOR (n:${label}) REQUIRE n.importKey IS UNIQUE`);
    if (label !== 'OpenChatImportedChat') await session.run(`CREATE INDEX ${label.toLowerCase()}_chat IF NOT EXISTS FOR (n:${label}) ON (n.chatId)`);
  }
  await session.run('CREATE INDEX openchatimportedchat_owner IF NOT EXISTS FOR (n:OpenChatImportedChat) ON (n.ownerUserId)');
  await session.run('CREATE INDEX openchatimportedmessage_page IF NOT EXISTS FOR (n:OpenChatImportedMessage) ON (n.chatId, n.sentAt)');
}

interface StoredMessage { sourceMessageId: string; senderKey: string | null; sentAt: string; kind: MessageKind; text: string | null; originalText: string | null; editedAt: string | null; deletedAtSource: string | null }
interface StoredParticipant { id: string; sourceKey: string; displayName: string | null; nameSource: NameSource; nameSourceMessageIds: string[] | null; membership: Membership | null; isOwner: boolean }
interface StoredClaim { importKey: string; text: string; sourceMessageIds: string[]; stale: boolean; signature: string }

export interface ImportCounts {
  participants: { created: number; updated: number; unchanged: number };
  messages: { created: number; edited: number; deleted: number; unchanged: number };
  asks: { created: number; updated: number; unchanged: number; markedStale: number };
  profileFacts: { created: number; updated: number; unchanged: number; markedStale: number };
}
export interface ImportConflict { sourceMessageId: string; field: 'senderKey' | 'sentAt'; message: string }
export interface ImportResult { dryRun: boolean; chatId: string | null; created: boolean; counts: ImportCounts; conflicts: ImportConflict[] }

const rows = <T>(result: { records: Array<{ get(key: string): unknown }> }, key: string) => result.records.map(record => record.get(key) as T);
const maxIso = (a: string | null, b: string | null) => !a ? b : !b ? a : (a > b ? a : b);
const minIso = (a: string | null, b: string | null) => !a ? b : !b ? a : (a < b ? a : b);

/**
 * Upsert one imported chat for `ownerUserId`, atomically. With `dryRun`
 * nothing is written and the same summary is returned.
 */
export async function importChat(ownerUserId: string, body: unknown, options: { dryRun?: boolean; importedBy: string }): Promise<ImportResult> {
  const payload = parseImportPayload(body);
  const session = getDriver().session();
  try {
    const work = (tx: ManagedTransaction) => applyImport(tx, ownerUserId, payload, !!options.dryRun, options.importedBy);
    return options.dryRun ? await session.executeRead(work) : await session.executeWrite(work);
  } finally { await session.close(); }
}

async function applyImport(tx: ManagedTransaction, ownerUserId: string, payload: ImportPayload, dryRun: boolean, importedBy: string): Promise<ImportResult> {
  const { source, coverage } = payload;
  const now = new Date().toISOString();
  const chatImportKey = compositeKey(ownerUserId, source.network, source.accountKey, source.chatKey);
  // The owner must still exist. A real import also write-locks the owner's User node, so it serializes with
  // account deletion (which removes the archives in the same transaction as the User): a token that outlives
  // its account can never recreate an orphan archive.
  const owner = await tx.run(dryRun
    ? 'MATCH (u:User {id: $ownerUserId}) RETURN u.id AS id'
    : 'MATCH (u:User {id: $ownerUserId}) SET u.importedChatsRevision = coalesce(u.importedChatsRevision, 0) + 1 RETURN u.id AS id', { ownerUserId });
  if (!owner.records.length) fail(404, 'Account not found');
  // A real import creates or touches the chat node first, taking its write lock, and only then reads it,
  // so two imports of one chat serialize and the second sees everything the first wrote.
  const chatRead = dryRun
    ? await tx.run('MATCH (c:OpenChatImportedChat {importKey: $importKey, ownerUserId: $ownerUserId}) RETURN c { .* } AS chat', { importKey: chatImportKey, ownerUserId })
    : await tx.run(
      `MERGE (c:OpenChatImportedChat {importKey: $importKey})
       ON CREATE SET c.id = $newId, c.ownerUserId = $ownerUserId, c.network = $network, c.accountKey = $accountKey, c.chatKey = $chatKey, c.createdAt = $now, c.importCount = 0
       SET c.lockedAt = $now
       RETURN c { .* } AS chat`,
      { importKey: chatImportKey, newId: nanoid(), ownerUserId, network: source.network, accountKey: source.accountKey, chatKey: source.chatKey, now });
  const chatNode = chatRead.records[0]?.get('chat') as Record<string, unknown> | undefined;
  if (chatNode && chatNode.ownerUserId !== ownerUserId) fail(404, 'Imported chat not found');
  const created = !chatNode || Number(chatNode.importCount ?? 0) === 0;
  const before = created ? undefined : chatNode;
  const chatId = (chatNode?.id as string | undefined) ?? null;
  // Imports only move forward: a snapshot older than one already applied could roll back newer text, names and asks.
  if (before?.asOf && coverage.asOf < (before.asOf as string)) {
    fail(409, `A newer import of this chat (as of ${before.asOf as string}) is already saved. Send a snapshot as of that time or later.`, { currentAsOf: before.asOf });
  }
  const scoped = (part: string) => compositeKey(chatId ?? 'new', part);

  // What is already stored for the keys this payload touches or cites.
  const participantKeys = new Set<string>(payload.participants.map(p => p.sourceKey));
  const citedMessageIds = new Set<string>();
  for (const m of payload.messages) { if (m.senderKey) participantKeys.add(m.senderKey); }
  for (const a of payload.asks) { if (a.subjectKey) participantKeys.add(a.subjectKey); participantKeys.add(a.reporterKey); a.sourceMessageIds.forEach(id => citedMessageIds.add(id)); a.statusSourceMessageIds.forEach(id => citedMessageIds.add(id)); }
  for (const p of payload.participants) { p.nameSourceMessageIds.forEach(id => citedMessageIds.add(id)); for (const f of p.profileFacts) f.sourceMessageIds.forEach(id => citedMessageIds.add(id)); }
  const payloadMessageIds = new Set(payload.messages.map(m => m.sourceMessageId));
  const lookupMessageIds = [...new Set([...payloadMessageIds, ...citedMessageIds])];

  const storedParticipants = new Map<string, StoredParticipant>();
  const storedMessages = new Map<string, StoredMessage>();
  if (chatId) {
    for (const p of rows<StoredParticipant>(await tx.run(
      'MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId}) WHERE p.sourceKey IN $keys RETURN p { .id, .sourceKey, .displayName, .nameSource, .nameSourceMessageIds, .membership, .isOwner } AS p',
      { chatId, ownerUserId, keys: [...participantKeys] }), 'p')) storedParticipants.set(p.sourceKey, p);
    for (const m of rows<StoredMessage>(await tx.run(
      'MATCH (m:OpenChatImportedMessage) WHERE m.importKey IN $keys AND m.ownerUserId = $ownerUserId RETURN m { .sourceMessageId, .senderKey, .sentAt, .kind, .text, .originalText, .editedAt, .deletedAtSource } AS m',
      { keys: lookupMessageIds.map(scoped), ownerUserId }), 'm')) storedMessages.set(m.sourceMessageId, m);
  }

  // References must resolve to this payload or what is already imported into this chat.
  const issues: ValidationIssue[] = [];
  const payloadParticipantKeys = new Set(payload.participants.map(p => p.sourceKey));
  const knownParticipant = (key: string) => payloadParticipantKeys.has(key) || storedParticipants.has(key);
  const knownMessage = (id: string) => payloadMessageIds.has(id) || storedMessages.has(id);
  const payloadSenders = new Map(payload.messages.map(m => [m.sourceMessageId, m.senderKey]));
  const senderOf = (id: string) => payloadSenders.has(id) ? payloadSenders.get(id) ?? null : storedMessages.get(id)?.senderKey ?? null;
  payload.messages.forEach((m, i) => { if (m.senderKey && !knownParticipant(m.senderKey)) issues.push({ path: `messages[${i}].senderKey`, message: `names no participant ${JSON.stringify(m.senderKey)}` }); });
  payload.asks.forEach((a, i) => {
    if (a.subjectKey && !knownParticipant(a.subjectKey)) issues.push({ path: `asks[${i}].subjectKey`, message: `names no participant ${JSON.stringify(a.subjectKey)}` });
    if (!knownParticipant(a.reporterKey)) issues.push({ path: `asks[${i}].reporterKey`, message: `names no participant ${JSON.stringify(a.reporterKey)}` });
    [...a.sourceMessageIds, ...a.statusSourceMessageIds].forEach(id => { if (!knownMessage(id)) issues.push({ path: `asks[${i}]`, message: `cites missing source message ${JSON.stringify(id)}` }); });
    // Attribution: whoever is named as having said the ask must have sent at least one of the messages that state it.
    if (a.sourceMessageIds.every(knownMessage) && !a.sourceMessageIds.some(id => senderOf(id) === a.reporterKey)) {
      issues.push({ path: `asks[${i}].reporterKey`, message: 'must be the sender of at least one of the ask\'s source messages' });
    }
  });
  payload.participants.forEach((p, i) => p.nameSourceMessageIds.forEach(id => { if (!knownMessage(id)) issues.push({ path: `participants[${i}].nameSourceMessageIds`, message: `cites missing source message ${JSON.stringify(id)}` }); }));
  payload.participants.forEach((p, i) => p.profileFacts.forEach((f, j) => f.sourceMessageIds.forEach(id => { if (!knownMessage(id)) issues.push({ path: `participants[${i}].profileFacts[${j}]`, message: `cites missing source message ${JSON.stringify(id)}` }); })));
  if (issues.length) fail(400, 'The import was not saved. Fix these problems and send it again.', { errors: issues.slice(0, 200) });

  const counts: ImportCounts = {
    participants: { created: 0, updated: 0, unchanged: 0 },
    messages: { created: 0, edited: 0, deleted: 0, unchanged: 0 },
    asks: { created: 0, updated: 0, unchanged: 0, markedStale: 0 },
    profileFacts: { created: 0, updated: 0, unchanged: 0, markedStale: 0 },
  };
  const conflicts: ImportConflict[] = [];

  // Participants: names (with their source) and membership follow the latest import that supplies them; an import never clears either.
  // A new participant gets the next stable number in this chat, so unnamed people read "Unknown participant 3", never a source id.
  const participantWrites: Array<Record<string, unknown>> = [];
  const participantIds = new Map<string, string>([...storedParticipants].map(([key, p]) => [key, p.id]));
  let nextOrdinal = chatId ? Number((await tx.run('MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId}) RETURN coalesce(max(p.ordinal), 0) AS n', { chatId, ownerUserId })).records[0]!.get('n')) + 1 : 1;
  const sameIds = (a: string[] | null | undefined, b: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b);
  for (const p of payload.participants) {
    const stored = storedParticipants.get(p.sourceKey);
    if (!stored) {
      const id = nanoid();
      participantIds.set(p.sourceKey, id);
      counts.participants.created += 1;
      participantWrites.push({ id, ordinal: neo4j.int(nextOrdinal++), importKey: scoped(p.sourceKey), sourceKey: p.sourceKey, displayName: p.displayName, nameSource: p.displayName ? p.nameSource : 'unknown', nameSourceMessageIds: p.displayName ? p.nameSourceMessageIds : [], membership: p.membership ?? 'unknown', isOwner: p.isOwner === true, create: true });
      continue;
    }
    const named = !!p.displayName;
    const displayName = p.displayName ?? stored.displayName;
    const nameSource = named ? p.nameSource : stored.nameSource;
    const nameSourceMessageIds = named ? p.nameSourceMessageIds : (stored.nameSourceMessageIds ?? []);
    const membership = p.membership ?? stored.membership ?? 'unknown';
    const isOwner = p.isOwner ?? stored.isOwner ?? false;
    if (displayName === stored.displayName && nameSource === stored.nameSource && sameIds(stored.nameSourceMessageIds, nameSourceMessageIds) && membership === (stored.membership ?? 'unknown') && isOwner === (stored.isOwner ?? false)) { counts.participants.unchanged += 1; continue; }
    counts.participants.updated += 1;
    participantWrites.push({ id: stored.id, importKey: scoped(p.sourceKey), sourceKey: p.sourceKey, displayName, nameSource, nameSourceMessageIds, membership, isOwner, create: false });
  }

  // Messages: source id, sender and time are immutable; text follows the source; deletion is final.
  const messageWrites: Array<Record<string, unknown>> = [];
  let earliest: string | null = null, latest: string | null = null;
  for (const m of payload.messages) {
    const stored = storedMessages.get(m.sourceMessageId);
    if (!stored || (stored.senderKey ?? null) === m.senderKey && stored.sentAt === m.sentAt) { earliest = minIso(earliest, m.sentAt); latest = maxIso(latest, m.sentAt); }
    const senderParticipantId = m.senderKey ? participantIds.get(m.senderKey) ?? null : null;
    if (!stored) {
      counts.messages.created += 1;
      messageWrites.push({ id: nanoid(), importKey: scoped(m.sourceMessageId), sourceMessageId: m.sourceMessageId, senderKey: m.senderKey, senderParticipantId, sentAt: m.sentAt, kind: m.kind, text: m.text, originalText: null, mediaType: m.mediaType, editedAt: m.editedAt, deletedAtSource: m.kind === 'deleted' ? now : null, replyToSourceMessageId: m.replyToSourceMessageId, revision: 0, create: true });
      continue;
    }
    if ((stored.senderKey ?? null) !== m.senderKey) { conflicts.push({ sourceMessageId: m.sourceMessageId, field: 'senderKey', message: 'The source sender differs from the first import; the message was left unchanged.' }); continue; }
    if (stored.sentAt !== m.sentAt) { conflicts.push({ sourceMessageId: m.sourceMessageId, field: 'sentAt', message: 'The source time differs from the first import; the message was left unchanged.' }); continue; }
    if (stored.deletedAtSource) { counts.messages.unchanged += 1; continue; }
    if (m.kind === 'deleted') {
      counts.messages.deleted += 1;
      messageWrites.push({ importKey: scoped(m.sourceMessageId), kind: 'deleted', text: null, originalText: null, editedAt: stored.editedAt, deletedAtSource: now, mediaType: null, create: false });
      continue;
    }
    if ((stored.text ?? null) === m.text && stored.kind === m.kind) { counts.messages.unchanged += 1; continue; }
    counts.messages.edited += 1;
    messageWrites.push({ importKey: scoped(m.sourceMessageId), kind: m.kind, text: m.text, originalText: stored.originalText ?? stored.text, editedAt: m.editedAt ?? now, deletedAtSource: null, mediaType: m.mediaType, create: false });
  }

  // Asks and facts: content follows the source; the owner's status is never touched; unlisted ones whose evidence was re-sent become stale.
  const claimSignature = (...parts: unknown[]) => JSON.stringify(parts);
  const existingClaims = async (label: 'OpenChatImportedAsk' | 'OpenChatImportedFact', extra: string): Promise<StoredClaim[]> => chatId ? rows<StoredClaim>(await tx.run(
    `MATCH (n:${label} {chatId: $chatId, ownerUserId: $ownerUserId}) RETURN n { .importKey, .text, .sourceMessageIds, .stale, signature: ${extra} } AS n`,
    { chatId, ownerUserId }), 'n') : [];
  const askRows = await existingClaims('OpenChatImportedAsk', '[n.text, n.subjectKey, n.subjectLabel, n.reporterKey, n.sourceMessageIds, n.sourceStatus, n.statusSourceMessageIds]');
  const factRows = await existingClaims('OpenChatImportedFact', '[n.text, n.sourceMessageIds]');
  const storedAsks = new Map(askRows.map(a => [a.importKey, a]));
  const storedFacts = new Map(factRows.map(f => [f.importKey, f]));

  const askWrites: Array<Record<string, unknown>> = [];
  const listedAsks = new Set<string>();
  for (const a of payload.asks) {
    const importKey = scoped(`ask:${a.askKey}`);
    listedAsks.add(importKey);
    const values = { text: a.text, subjectKey: a.subjectKey, subjectLabel: a.subjectLabel, reporterKey: a.reporterKey, sourceMessageIds: a.sourceMessageIds, sourceStatus: a.sourceStatus, statusSourceMessageIds: a.statusSourceMessageIds };
    const stored = storedAsks.get(importKey);
    if (!stored) { counts.asks.created += 1; askWrites.push({ ...values, id: nanoid(), importKey, askKey: a.askKey, create: true }); continue; }
    const same = JSON.stringify(stored.signature) === claimSignature(a.text, a.subjectKey, a.subjectLabel, a.reporterKey, a.sourceMessageIds, a.sourceStatus, a.statusSourceMessageIds);
    if (same && !stored.stale) { counts.asks.unchanged += 1; continue; }
    counts.asks.updated += 1;
    askWrites.push({ ...values, importKey, create: false });
  }
  const factWrites: Array<Record<string, unknown>> = [];
  const listedFacts = new Set<string>();
  for (const p of payload.participants) for (const f of p.profileFacts) {
    const importKey = scoped(compositeKey('fact', p.sourceKey, f.factKey));
    listedFacts.add(importKey);
    const stored = storedFacts.get(importKey);
    if (!stored) { counts.profileFacts.created += 1; factWrites.push({ id: nanoid(), importKey, factKey: f.factKey, participantKey: p.sourceKey, participantId: participantIds.get(p.sourceKey), text: f.text, sourceMessageIds: f.sourceMessageIds, create: true }); continue; }
    if (JSON.stringify(stored.signature) === claimSignature(f.text, f.sourceMessageIds) && !stored.stale) { counts.profileFacts.unchanged += 1; continue; }
    counts.profileFacts.updated += 1;
    factWrites.push({ importKey, text: f.text, sourceMessageIds: f.sourceMessageIds, create: false });
  }
  const staleKeys = (stored: StoredClaim[], listed: Set<string>) => stored
    .filter(claim => !listed.has(claim.importKey) && !claim.stale && claim.sourceMessageIds.length > 0 && claim.sourceMessageIds.every(id => payloadMessageIds.has(id)))
    .map(claim => claim.importKey);
  const staleAsks = staleKeys(askRows, listedAsks), staleFacts = staleKeys(factRows, listedFacts);
  counts.asks.markedStale = staleAsks.length; counts.profileFacts.markedStale = staleFacts.length;

  const result: ImportResult = { dryRun, chatId, created, counts, conflicts };
  if (dryRun) return result;

  const base = { chatId, ownerUserId, now };
  if (participantWrites.some(p => p.isOwner === true)) {
    await tx.run('MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId}) WHERE p.isOwner = true AND NOT p.sourceKey IN $keys SET p.isOwner = false, p.updatedAt = $now',
      { ...base, keys: participantWrites.filter(p => p.isOwner === true).map(p => p.sourceKey) });
  }
  await tx.run(
    `UNWIND $rows AS row
     MERGE (p:OpenChatImportedParticipant {importKey: row.importKey})
     ON CREATE SET p.id = row.id, p.ordinal = row.ordinal, p.chatId = $chatId, p.ownerUserId = $ownerUserId, p.sourceKey = row.sourceKey, p.createdAt = $now
     SET p.displayName = row.displayName, p.nameSource = row.nameSource, p.nameSourceMessageIds = row.nameSourceMessageIds, p.membership = row.membership, p.isOwner = row.isOwner, p.updatedAt = $now`,
    { ...base, rows: participantWrites });
  for (let i = 0; i < messageWrites.length; i += 1000) {
    const batch = messageWrites.slice(i, i + 1000);
    await tx.run(
      `UNWIND $rows AS row WITH row WHERE row.create
       CREATE (m:OpenChatImportedMessage {id: row.id, importKey: row.importKey, chatId: $chatId, ownerUserId: $ownerUserId, sourceMessageId: row.sourceMessageId,
         senderKey: row.senderKey, senderParticipantId: row.senderParticipantId, sentAt: row.sentAt, kind: row.kind, text: row.text, originalText: null,
         mediaType: row.mediaType, editedAt: row.editedAt, deletedAtSource: row.deletedAtSource, replyToSourceMessageId: row.replyToSourceMessageId,
         revision: 0, importedAt: $now, updatedAt: $now})`,
      { ...base, rows: batch });
    await tx.run(
      `UNWIND $rows AS row WITH row WHERE NOT row.create
       MATCH (m:OpenChatImportedMessage {importKey: row.importKey, ownerUserId: $ownerUserId})
       SET m.kind = row.kind, m.text = row.text, m.originalText = row.originalText, m.editedAt = row.editedAt, m.deletedAtSource = row.deletedAtSource,
           m.mediaType = row.mediaType, m.revision = coalesce(m.revision, 0) + 1, m.updatedAt = $now`,
      { ...base, rows: batch });
  }
  await tx.run(
    `UNWIND $rows AS row
     MERGE (a:OpenChatImportedAsk {importKey: row.importKey})
     ON CREATE SET a.id = row.id, a.chatId = $chatId, a.ownerUserId = $ownerUserId, a.askKey = row.askKey, a.ownerStatus = null, a.createdAt = $now
     SET a.text = row.text, a.subjectKey = row.subjectKey, a.subjectLabel = row.subjectLabel, a.reporterKey = row.reporterKey, a.sourceMessageIds = row.sourceMessageIds,
         a.sourceStatus = row.sourceStatus, a.statusSourceMessageIds = row.statusSourceMessageIds, a.stale = false, a.updatedAt = $now`,
    { ...base, rows: askWrites });
  await tx.run(
    `UNWIND $rows AS row
     MERGE (f:OpenChatImportedFact {importKey: row.importKey})
     ON CREATE SET f.id = row.id, f.chatId = $chatId, f.ownerUserId = $ownerUserId, f.factKey = row.factKey, f.participantKey = row.participantKey, f.participantId = row.participantId, f.createdAt = $now
     SET f.text = row.text, f.sourceMessageIds = row.sourceMessageIds, f.stale = false, f.updatedAt = $now`,
    { ...base, rows: factWrites });
  await tx.run('MATCH (a:OpenChatImportedAsk {ownerUserId: $ownerUserId}) WHERE a.importKey IN $keys SET a.stale = true, a.updatedAt = $now', { ...base, keys: staleAsks });
  await tx.run('MATCH (f:OpenChatImportedFact {ownerUserId: $ownerUserId}) WHERE f.importKey IN $keys SET f.stale = true, f.updatedAt = $now', { ...base, keys: staleFacts });

  await tx.run(
    `MATCH (c:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId})
     SET c.chatType = $chatType, c.title = $title, c.asOf = CASE WHEN c.asOf IS NULL OR c.asOf < $asOf THEN $asOf ELSE c.asOf END,
         c.method = $method, c.complete = $complete, c.note = $note,
         c.sourceRowTotal = CASE WHEN $rows IS NULL THEN c.sourceRowTotal ELSE $rows.total END,
         c.sourceRowText = CASE WHEN $rows IS NULL THEN c.sourceRowText ELSE $rows.text END,
         c.sourceRowNonText = CASE WHEN $rows IS NULL THEN c.sourceRowNonText ELSE $rows.nonText END,
         c.earliestMessageAt = CASE WHEN c.earliestMessageAt IS NULL OR $earliest < c.earliestMessageAt THEN $earliest ELSE c.earliestMessageAt END,
         c.latestMessageAt = CASE WHEN c.latestMessageAt IS NULL OR $latest > c.latestMessageAt THEN $latest ELSE c.latestMessageAt END,
         c.importCount = coalesce(c.importCount, 0) + 1, c.lastImportAt = $now, c.lastImportedBy = $importedBy, c.updatedAt = $now
     REMOVE c.lockedAt`,
    {
      ...base, chatType: source.chatType, title: source.title, asOf: coverage.asOf, method: coverage.method, complete: coverage.complete, note: coverage.note, importedBy, rows: coverage.sourceRowCounts ? { total: neo4j.int(coverage.sourceRowCounts.total), text: coverage.sourceRowCounts.text === null ? null : neo4j.int(coverage.sourceRowCounts.text), nonText: coverage.sourceRowCounts.nonText === null ? null : neo4j.int(coverage.sourceRowCounts.nonText) } : null,
      earliest: minIso(minIso((before?.earliestMessageAt as string | null) ?? null, coverage.earliestMessageAt), earliest),
      latest: maxIso(maxIso((before?.latestMessageAt as string | null) ?? null, coverage.latestMessageAt), latest),
    });
  return result;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export interface Coverage { asOf: string | null; method: string | null; earliestMessageAt: string | null; latestMessageAt: string | null; complete: boolean; note: string | null; sourceRowCounts: SourceRowCounts | null; lastImportAt: string | null; importCount: number }
export interface ImportedChatSummary { id: string; network: string; chatType: 'group' | 'direct'; title: string; coverage: Coverage; counts: { messages: number; participants: number; openAsks: number } }
export interface ParticipantRef { participantId: string; label: string; displayName: string | null; isOwner: boolean }
export interface ImportedPerson extends ParticipantRef { nameSource: NameSource; membership: Membership; messageCount: number; firstMessageAt: string | null; lastMessageAt: string | null; factCount: number; askCount: number }
export interface ImportedMessageView { id: string; sourceMessageId: string; sentAt: string; kind: MessageKind; text: string | null; mediaType: string | null; edited: boolean; editedAt: string | null; originalText: string | null; deletedAtSource: string | null; replyToSourceMessageId: string | null; sender: ParticipantRef | null }
export interface SourceExcerpt { sourceMessageId: string; sentAt: string | null; sender: ParticipantRef | null; text: string | null; available: boolean }
export interface ImportedFactView { id: string; text: string; stale: boolean; sources: SourceExcerpt[] }
export interface ImportedAskView { id: string; text: string; subject: ParticipantRef | null; subjectLabel: string | null; reporter: ParticipantRef | null; sourceStatus: SourceStatus; ownerStatus: OwnerStatus | null; status: SourceStatus; stale: boolean; sources: SourceExcerpt[]; statusSources: SourceExcerpt[]; updatedAt: string }

const notFound = () => fail(404, 'Imported chat not found');
async function read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try { return await session.executeRead(work); } finally { await session.close(); }
}
async function write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try { return await session.executeWrite(work); } finally { await session.close(); }
}

/** "Unknown participant" plus a short, stable suffix — never derived from the source key, which may be a phone number. */
export function participantLabel(p: { id: string; displayName?: string | null; ordinal?: unknown }): string {
  if (p.displayName) return p.displayName;
  const ordinal = Number(p.ordinal ?? NaN);
  return Number.isInteger(ordinal) && ordinal > 0 ? `Unknown participant ${ordinal}` : `Unknown participant · ${p.id.slice(-4)}`;
}
const toRef = (p: Record<string, unknown> | null | undefined): ParticipantRef | null => p && p.id
  ? { participantId: p.id as string, label: participantLabel(p as { id: string; displayName: string | null; ordinal?: unknown }), displayName: (p.displayName as string | null) ?? null, isOwner: p.isOwner === true }
  : null;
const coverageOf = (c: Record<string, unknown>): Coverage => ({
  asOf: (c.asOf as string) ?? null, method: (c.method as string) ?? null, earliestMessageAt: (c.earliestMessageAt as string) ?? null, latestMessageAt: (c.latestMessageAt as string) ?? null,
  complete: c.complete === true, note: (c.note as string) ?? null,
  sourceRowCounts: c.sourceRowTotal === null || c.sourceRowTotal === undefined ? null : { total: Number(c.sourceRowTotal), text: c.sourceRowText == null ? null : Number(c.sourceRowText), nonText: c.sourceRowNonText == null ? null : Number(c.sourceRowNonText) },
  lastImportAt: (c.lastImportAt as string) ?? null, importCount: Number(c.importCount ?? 0),
});

async function requireChat(tx: ManagedTransaction, ownerUserId: string, chatId: string): Promise<Record<string, unknown>> {
  const result = await tx.run('MATCH (c:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId}) RETURN c { .* } AS c', { chatId, ownerUserId });
  return (result.records[0]?.get('c') as Record<string, unknown> | undefined) ?? notFound();
}

export async function listImportedChats(ownerUserId: string): Promise<{ chats: ImportedChatSummary[] }> {
  return read(async tx => {
    const result = await tx.run(
      `MATCH (c:OpenChatImportedChat {ownerUserId: $ownerUserId})
       CALL { WITH c MATCH (m:OpenChatImportedMessage {chatId: c.id}) RETURN count(m) AS messages }
       CALL { WITH c MATCH (p:OpenChatImportedParticipant {chatId: c.id}) RETURN count(p) AS participants }
       CALL { WITH c MATCH (a:OpenChatImportedAsk {chatId: c.id}) WHERE coalesce(a.ownerStatus, a.sourceStatus) = 'open' AND coalesce(a.stale, false) = false RETURN count(a) AS openAsks }
       RETURN c { .* } AS c, messages, participants, openAsks ORDER BY coalesce(c.latestMessageAt, c.createdAt) DESC`,
      { ownerUserId });
    return { chats: result.records.map(record => summary(record.get('c'), { messages: Number(record.get('messages')), participants: Number(record.get('participants')), openAsks: Number(record.get('openAsks')) })) };
  });
}

function summary(c: Record<string, unknown>, counts: ImportedChatSummary['counts']): ImportedChatSummary {
  return { id: c.id as string, network: c.network as string, chatType: (c.chatType as 'group' | 'direct') ?? 'group', title: (c.title as string) ?? 'Imported chat', coverage: coverageOf(c), counts };
}

export async function getImportedChat(ownerUserId: string, chatId: string): Promise<ImportedChatSummary> {
  return read(async tx => {
    const c = await requireChat(tx, ownerUserId, chatId);
    const result = await tx.run(
      `CALL { MATCH (m:OpenChatImportedMessage {chatId: $chatId, ownerUserId: $ownerUserId}) RETURN count(m) AS messages }
       CALL { MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId}) RETURN count(p) AS participants }
       CALL { MATCH (a:OpenChatImportedAsk {chatId: $chatId, ownerUserId: $ownerUserId}) WHERE coalesce(a.ownerStatus, a.sourceStatus) = 'open' AND coalesce(a.stale, false) = false RETURN count(a) AS openAsks }
       RETURN messages, participants, openAsks`, { chatId, ownerUserId });
    const r = result.records[0]!;
    return summary(c, { messages: Number(r.get('messages')), participants: Number(r.get('participants')), openAsks: Number(r.get('openAsks')) });
  });
}

const encodeCursor = (sentAt: string, sourceMessageId: string) => Buffer.from(JSON.stringify([sentAt, sourceMessageId])).toString('base64url');
function decodeCursor(value: unknown): [string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(part => typeof part === 'string')) return parsed as [string, string];
  } catch { /* fall through */ }
  return fail(400, 'Invalid cursor');
}
function pageSize(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, IMPORT_LIMITS.pageSize) : fail(400, `limit must be a whole number from 1 to ${IMPORT_LIMITS.pageSize}`);
}

const MESSAGE_VIEW = `m { .id, .sourceMessageId, .sentAt, .kind, .text, .mediaType, .editedAt, .originalText, .deletedAtSource, .replyToSourceMessageId, .revision } AS m, p { .id, .displayName, .isOwner, .ordinal } AS p`;
function messageView(m: Record<string, unknown>, p: Record<string, unknown> | null): ImportedMessageView {
  return {
    id: m.id as string, sourceMessageId: m.sourceMessageId as string, sentAt: m.sentAt as string, kind: m.kind as MessageKind, text: (m.text as string) ?? null, mediaType: (m.mediaType as string) ?? null,
    edited: (Number(m.revision ?? 0) > 0 || !!m.editedAt) && !m.deletedAtSource, editedAt: (m.editedAt as string) ?? null, originalText: (m.originalText as string) ?? null,
    deletedAtSource: (m.deletedAtSource as string) ?? null, replyToSourceMessageId: (m.replyToSourceMessageId as string) ?? null, sender: toRef(p),
  };
}

/** Newest first; `nextCursor` pages back in time. */
export async function listImportedMessages(ownerUserId: string, chatId: string, query: { before?: unknown; limit?: unknown; participantId?: unknown }): Promise<{ messages: ImportedMessageView[]; nextCursor: string | null }> {
  const cursor = decodeCursor(query.before);
  const limit = pageSize(query.limit, 50);
  const participantId = typeof query.participantId === 'string' && query.participantId ? query.participantId : null;
  return read(async tx => {
    await requireChat(tx, ownerUserId, chatId);
    const result = await tx.run(
      `MATCH (m:OpenChatImportedMessage {chatId: $chatId, ownerUserId: $ownerUserId})
       WHERE ($cursorAt IS NULL OR m.sentAt < $cursorAt OR (m.sentAt = $cursorAt AND m.sourceMessageId < $cursorId))
         AND ($participantId IS NULL OR m.senderParticipantId = $participantId)
       WITH m ORDER BY m.sentAt DESC, m.sourceMessageId DESC LIMIT $limit
       OPTIONAL MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId, id: m.senderParticipantId})
       RETURN ${MESSAGE_VIEW} ORDER BY m.sentAt DESC, m.sourceMessageId DESC`,
      { chatId, ownerUserId, cursorAt: cursor?.[0] ?? null, cursorId: cursor?.[1] ?? null, participantId, limit: neo4j.int(limit + 1) });
    const page = result.records.map(record => messageView(record.get('m'), record.get('p')));
    const more = page.length > limit;
    const messages = page.slice(0, limit);
    const last = messages[messages.length - 1];
    return { messages, nextCursor: more && last ? encodeCursor(last.sentAt, last.sourceMessageId) : null };
  });
}

function personOf(p: Record<string, unknown>, stats: Record<string, unknown>): ImportedPerson {
  return {
    ...toRef(p)!, nameSource: (p.nameSource as NameSource) ?? 'unknown', membership: (p.membership as Membership) ?? 'unknown',
    messageCount: Number(stats.messageCount ?? 0), firstMessageAt: (stats.firstMessageAt as string) ?? null, lastMessageAt: (stats.lastMessageAt as string) ?? null,
    factCount: Number(stats.factCount ?? 0), askCount: Number(stats.askCount ?? 0),
  };
}
const PERSON_STATS = `
  CALL { WITH p MATCH (m:OpenChatImportedMessage {chatId: p.chatId, senderParticipantId: p.id}) RETURN count(m) AS messageCount, min(m.sentAt) AS firstMessageAt, max(m.sentAt) AS lastMessageAt }
  CALL { WITH p MATCH (f:OpenChatImportedFact {chatId: p.chatId, participantId: p.id}) RETURN count(f) AS factCount }
  CALL { WITH p MATCH (a:OpenChatImportedAsk {chatId: p.chatId}) WHERE a.subjectKey = p.sourceKey RETURN count(a) AS askCount }`;

export async function listImportedPeople(ownerUserId: string, chatId: string): Promise<{ people: ImportedPerson[] }> {
  return read(async tx => {
    await requireChat(tx, ownerUserId, chatId);
    const result = await tx.run(
      `MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId}) ${PERSON_STATS}
       RETURN p { .* } AS p, { messageCount: messageCount, firstMessageAt: firstMessageAt, lastMessageAt: lastMessageAt, factCount: factCount, askCount: askCount } AS stats`,
      { chatId, ownerUserId });
    const raw = result.records.map(record => ({ p: record.get('p') as Record<string, unknown>, stats: record.get('stats') as Record<string, unknown> }));
    const people = raw.map(r => personOf(r.p, r.stats));
    people.sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || b.messageCount - a.messageCount || Number(!a.displayName) - Number(!b.displayName) || a.label.localeCompare(b.label));
    return { people };
  });
}

async function excerpts(tx: ManagedTransaction, ownerUserId: string, chatId: string, ids: string[]): Promise<Map<string, SourceExcerpt>> {
  if (!ids.length) return new Map();
  const result = await tx.run(
    `MATCH (m:OpenChatImportedMessage {chatId: $chatId, ownerUserId: $ownerUserId}) WHERE m.sourceMessageId IN $ids
     OPTIONAL MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId, id: m.senderParticipantId})
     RETURN ${MESSAGE_VIEW}`, { chatId, ownerUserId, ids: [...new Set(ids)] });
  return new Map(result.records.map(record => {
    const m = messageView(record.get('m'), record.get('p'));
    return [m.sourceMessageId, { sourceMessageId: m.sourceMessageId, sentAt: m.sentAt, sender: m.sender, text: m.text, available: true }];
  }));
}
const cite = (map: Map<string, SourceExcerpt>, ids: string[]): SourceExcerpt[] => ids.map(id => map.get(id) ?? { sourceMessageId: id, sentAt: null, sender: null, text: null, available: false });

async function askViews(tx: ManagedTransaction, ownerUserId: string, chatId: string, filter: string, params: Record<string, unknown> = {}): Promise<ImportedAskView[]> {
  const result = await tx.run(
    `MATCH (a:OpenChatImportedAsk {chatId: $chatId, ownerUserId: $ownerUserId}) ${filter}
     OPTIONAL MATCH (subject:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId, sourceKey: a.subjectKey})
     OPTIONAL MATCH (reporter:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId, sourceKey: a.reporterKey})
     RETURN a { .* } AS a, subject { .id, .displayName, .isOwner, .ordinal } AS subject, reporter { .id, .displayName, .isOwner, .ordinal } AS reporter`,
    { chatId, ownerUserId, ...params });
  const raw = result.records.map(record => ({ a: record.get('a') as Record<string, unknown>, subject: record.get('subject'), reporter: record.get('reporter') }));
  const sources = await excerpts(tx, ownerUserId, chatId, raw.flatMap(r => [...(r.a.sourceMessageIds as string[] ?? []), ...(r.a.statusSourceMessageIds as string[] ?? [])]));
  const order: Record<string, number> = { open: 0, needs_review: 1, unknown: 2, resolved: 3, withdrawn: 4 };
  return raw.map(({ a, subject, reporter }): ImportedAskView => {
    const ownerStatus = (a.ownerStatus as OwnerStatus) ?? null;
    return {
      id: a.id as string, text: a.text as string, subject: toRef(subject as Record<string, unknown> | null), subjectLabel: (a.subjectLabel as string) ?? null, reporter: toRef(reporter as Record<string, unknown> | null),
      sourceStatus: a.sourceStatus as SourceStatus, ownerStatus, status: ownerStatus ?? (a.sourceStatus as SourceStatus), stale: a.stale === true,
      sources: cite(sources, (a.sourceMessageIds as string[]) ?? []), statusSources: cite(sources, (a.statusSourceMessageIds as string[]) ?? []), updatedAt: a.updatedAt as string,
    };
  }).sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9) || (y.sources[0]?.sentAt ?? '').localeCompare(x.sources[0]?.sentAt ?? ''));
}

export async function listImportedAsks(ownerUserId: string, chatId: string): Promise<{ asks: ImportedAskView[] }> {
  return read(async tx => { await requireChat(tx, ownerUserId, chatId); return { asks: await askViews(tx, ownerUserId, chatId, '') }; });
}

/** The small profile: only what this chat evidences, each statement with its source messages. */
export async function getImportedPerson(ownerUserId: string, chatId: string, participantId: string): Promise<{ chat: { id: string; title: string; network: string; coverage: Coverage }; person: ImportedPerson; facts: ImportedFactView[]; asksAbout: ImportedAskView[]; asksReported: ImportedAskView[]; recentMessages: ImportedMessageView[]; nameSources: SourceExcerpt[] }> {
  return read(async tx => {
    const chat = await requireChat(tx, ownerUserId, chatId);
    const result = await tx.run(
      `MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId, id: $participantId}) ${PERSON_STATS}
       RETURN p { .* } AS p, { messageCount: messageCount, firstMessageAt: firstMessageAt, lastMessageAt: lastMessageAt, factCount: factCount, askCount: askCount } AS stats`,
      { chatId, ownerUserId, participantId });
    const record = result.records[0] ?? fail(404, 'Person not found in this imported chat');
    const p = record.get('p') as Record<string, unknown>;
    const factRows = rows<Record<string, unknown>>(await tx.run(
      'MATCH (f:OpenChatImportedFact {chatId: $chatId, ownerUserId: $ownerUserId, participantId: $participantId}) RETURN f { .* } AS f ORDER BY f.stale, f.createdAt',
      { chatId, ownerUserId, participantId }), 'f');
    const nameSourceIds = (p.nameSourceMessageIds as string[] | null) ?? [];
    const factSources = await excerpts(tx, ownerUserId, chatId, [...nameSourceIds, ...factRows.flatMap(f => (f.sourceMessageIds as string[]) ?? [])]);
    const recent = await tx.run(
      `MATCH (m:OpenChatImportedMessage {chatId: $chatId, ownerUserId: $ownerUserId, senderParticipantId: $participantId})
       WITH m ORDER BY m.sentAt DESC, m.sourceMessageId DESC LIMIT 10
       OPTIONAL MATCH (p:OpenChatImportedParticipant {chatId: $chatId, ownerUserId: $ownerUserId, id: m.senderParticipantId})
       RETURN ${MESSAGE_VIEW} ORDER BY m.sentAt DESC, m.sourceMessageId DESC`, { chatId, ownerUserId, participantId });
    return {
      chat: { id: chat.id as string, title: (chat.title as string) ?? 'Imported chat', network: chat.network as string, coverage: coverageOf(chat) },
      person: personOf(p, record.get('stats')),
      nameSources: cite(factSources, nameSourceIds),
      facts: factRows.map(f => ({ id: f.id as string, text: f.text as string, stale: f.stale === true, sources: cite(factSources, (f.sourceMessageIds as string[]) ?? []) })),
      asksAbout: await askViews(tx, ownerUserId, chatId, 'WHERE a.subjectKey = $sourceKey', { sourceKey: p.sourceKey }),
      asksReported: await askViews(tx, ownerUserId, chatId, 'WHERE a.reporterKey = $sourceKey AND coalesce(a.subjectKey, "") <> $sourceKey', { sourceKey: p.sourceKey }),
      recentMessages: recent.records.map(r => messageView(r.get('m'), r.get('p'))),
    };
  });
}

// ── Owner changes ─────────────────────────────────────────────────────────────

export async function setImportedAskStatus(ownerUserId: string, chatId: string, askId: string, body: unknown): Promise<ImportedAskView> {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!('ownerStatus' in input)) fail(400, 'Give ownerStatus');
  const ownerStatus = input.ownerStatus;
  if (ownerStatus !== null && !(OWNER_STATUSES as readonly unknown[]).includes(ownerStatus)) fail(400, `ownerStatus must be ${OWNER_STATUSES.join(', ')} or null`);
  return write(async tx => {
    await requireChat(tx, ownerUserId, chatId);
    const updated = await tx.run(
      `MATCH (a:OpenChatImportedAsk {id: $askId, chatId: $chatId, ownerUserId: $ownerUserId})
       SET a.ownerStatus = $ownerStatus, a.ownerStatusAt = $now, a.updatedAt = $now RETURN a.id AS id`,
      { askId, chatId, ownerUserId, ownerStatus, now: new Date().toISOString() });
    if (!updated.records.length) fail(404, 'Ask not found in this imported chat');
    return (await askViews(tx, ownerUserId, chatId, 'WHERE a.id = $askId', { askId }))[0]!;
  });
}

export async function deleteImportedChat(ownerUserId: string, chatId: string): Promise<{ deleted: true }> {
  return write(async tx => {
    await requireChat(tx, ownerUserId, chatId);
    for (const label of LABELS.slice(1)) {
      await tx.run(`MATCH (n:${label} {chatId: $chatId, ownerUserId: $ownerUserId}) DETACH DELETE n`, { chatId, ownerUserId });
    }
    await tx.run('MATCH (c:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId}) DETACH DELETE c', { chatId, ownerUserId });
    return { deleted: true as const };
  });
}
