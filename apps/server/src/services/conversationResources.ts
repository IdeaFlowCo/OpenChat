/**
 * Link resources of a conversation (OpenChat-c8to.3): every address shared in
 * a conversation, kept as one lasting entry with a guessed kind, suggested tags
 * any member can edit, and each member's own saved mark.
 *
 * On only where `Conversation.resourcesEnabled` is set (sharing an imported
 * chat into a group sets it). Entries are collected when a member opens the
 * list, from the conversation's own messages and from any mirror shared into
 * it, so the message send path is untouched. Tags and kind are shared by the
 * conversation; "saved" belongs to the member who set it. Private Stream entries,
 * private notes, asks and to-dos scoped to a conversation are never collected.
 */

import { nanoid } from 'nanoid';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { ImportedChatError, participantLabel } from './importedChats.js';
import { fetchPreview } from './linkPreview.js';
import { publicGet } from './publicFetch.js';
import { doiFromUrl, extractResourceUrls, inferResource, isResourceKind, normalizeResourceUrl, normalizeTags, ResourceInputError, type ResourceKind } from './resourceInference.js';
import { requireMember } from './sharedMirrors.js';

const fail = (status: number, message: string): never => { throw new ImportedChatError(status, message); };
const LIMITS = { scanMessages: 1000, scanBatches: 20, list: 500, enrichBatch: 12, enrichConcurrency: 4, enrichBudgetMs: 2500, description: 500, title: 300 } as const;
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Rescan this far behind the last scan, so a message committed late is still collected. */
const WATERMARK_OVERLAP_MS = 60_000;

type PreviewFetcher = (url: string) => Promise<{ title?: string | null; description?: string | null; siteName?: string | null } | null>;

/**
 * A paper's title from its DOI, for publishers that refuse page fetches. Asks
 * Crossref's public metadata API through the same guarded fetch as previews;
 * only the DOI from the shared address is sent.
 */
async function fetchDoiMetadata(doi: string): Promise<Awaited<ReturnType<PreviewFetcher>>> {
  try {
    const response = await publicGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      timeoutMs: 5_000, maxBytes: 1024 * 1024, headers: { 'User-Agent': 'OpenChat-LinkPreview/1.0 (+https://chat.ideaflow.app)', Accept: 'application/json' },
    });
    if (response.status !== 200) return null;
    const work = (JSON.parse(response.body.toString('utf8')) as { message?: Record<string, unknown> }).message ?? {};
    const first = (value: unknown) => Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
    const title = first(work.title);
    if (!title) return null;
    const venue = first(work['container-title']);
    return { title, description: venue ? `Published in ${venue}` : null, siteName: typeof work.publisher === 'string' ? work.publisher : null };
  } catch { return null; }
}

/** The page's own title and description; for a DOI whose page cannot be read, the paper's registered title. */
export async function fetchResourcePreview(url: string, pageFetcher: PreviewFetcher = fetchPreview, doiFetcher: PreviewFetcher = fetchDoiMetadata): Promise<Awaited<ReturnType<PreviewFetcher>>> {
  const doi = doiFromUrl(url);
  const metadata = doi ? await doiFetcher(doi) : null;
  return metadata ?? await pageFetcher(url);
}

let previewFetcher: PreviewFetcher = fetchResourcePreview;
/** Tests replace the public-web fetch; pass nothing to restore it. */
export function setResourcePreviewFetcher(fetcher?: PreviewFetcher): void { previewFetcher = fetcher ?? fetchResourcePreview; }

export interface ResourceView {
  id: string;
  url: string;
  host: string;
  kind: ResourceKind;
  kindEdited: boolean;
  title: string | null;
  description: string | null;
  siteName: string | null;
  tags: string[];
  suggestedTags: string[];
  tagsEdited: boolean;
  firstSharedAt: string | null;
  lastSharedAt: string | null;
  firstSharedBy: { label: string | null; userId: string | null };
  shareCount: number;
  /** Where it was shared: `openchat` and/or a mirrored network such as `imessage`. */
  sources: string[];
  saved: boolean;
  savedCount: number;
}
export interface ResourceList { enabled: boolean; resources: ResourceView[]; pending: number; nextCursor: string | null; indexingPending: boolean }

async function read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try { return await session.executeRead(work); } finally { await session.close(); }
}
async function write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try { return await session.executeWrite(work); } finally { await session.close(); }
}

export async function ensureConversationResourceSchema(session: { run(query: string): Promise<unknown> }): Promise<void> {
  await session.run('CREATE CONSTRAINT conversationresource_key IF NOT EXISTS FOR (r:ConversationResource) REQUIRE r.resourceKey IS UNIQUE');
  await session.run('CREATE CONSTRAINT conversationresource_id IF NOT EXISTS FOR (r:ConversationResource) REQUIRE r.id IS UNIQUE');
  await session.run('CREATE INDEX conversationresource_conversation IF NOT EXISTS FOR (r:ConversationResource) ON (r.conversationId)');
}

// ── Collecting ────────────────────────────────────────────────────────────────

interface Occurrence { url: string; at: string; byLabel: string | null; byUserId: string | null; source: string; occurrenceKey: string }
interface Pending { resourceKey: string; urlKey: string; url: string; host: string; occurrences: Occurrence[] }

function collect(into: Map<string, Pending>, conversationId: string, text: string | null, occurrence: Omit<Occurrence, 'url'>): void {
  const seen = new Set<string>();
  for (const raw of extractResourceUrls(text)) {
    const normalized = normalizeResourceUrl(raw);
    if (!normalized || seen.has(normalized.urlKey)) continue;
    seen.add(normalized.urlKey);
    const resourceKey = JSON.stringify([conversationId, normalized.urlKey]);
    const entry = into.get(resourceKey) ?? { resourceKey, urlKey: normalized.urlKey, url: normalized.url, host: normalized.host, occurrences: [] };
    entry.occurrences.push({ ...occurrence, url: normalized.url });
    into.set(resourceKey, entry);
  }
}

/** Collect addresses from messages not yet scanned. Idempotent: an occurrence is counted once. */
async function indexConversation(conversationId: string): Promise<boolean> {
  const now = new Date();
  return write(async tx => {
    const conversation = await tx.run(
      `MATCH (c:Conversation {id: $conversationId}) WHERE c.resourcesEnabled = true
       SET c.resourcesLockedAt = $now
       RETURN c.resourcesIndexedThrough AS through, c.resourcesIndexedThroughId AS throughId`, { conversationId, now: now.toISOString() });
    if (!conversation.records.length) return false;
    const through = conversation.records[0]!.get('through') as string | null;
    const throughId = conversation.records[0]!.get('throughId') as string | null;
    const pending = new Map<string, Pending>();
    const affected = new Set<string>();

    const messages = await tx.run(
      `MATCH (m:Message {conversationId: $conversationId})
       WITH m, coalesce(m.deletedAt, m.editedAt, m.createdAt) AS changedAt
       WHERE ($through IS NULL OR changedAt > datetime($through) OR (changedAt = datetime($through) AND $throughId IS NOT NULL AND m.id > $throughId))
       WITH m, changedAt ORDER BY changedAt, m.id LIMIT $limit
       OPTIONAL MATCH (u:User {id: m.senderId})
       RETURN m.id AS id, CASE WHEN m.deletedAt IS NULL AND coalesce(m.messageType, 'text') = 'text' AND toLower(m.content) CONTAINS 'http' THEN m.content ELSE null END AS content,
              toString(m.createdAt) AS at, toString(changedAt) AS changedAt, m.senderId AS senderId, u.name AS senderName`,
      { conversationId, through, throughId, limit: neo4j.int(LIMITS.scanMessages) });
    for (const record of messages.records) {
      const occurrenceKey = `m:${record.get('id') as string}`;
      affected.add(occurrenceKey);
      collect(pending, conversationId, record.get('content') as string | null, {
        at: new Date(record.get('at') as string).toISOString(), byLabel: (record.get('senderName') as string | null) ?? null, byUserId: record.get('senderId') as string, source: 'openchat', occurrenceKey,
      });
    }
    const lastAt = messages.records.length ? messages.records[messages.records.length - 1]!.get('changedAt') as string : null;
    const fullPage = messages.records.length >= LIMITS.scanMessages && !!lastAt;
    const nextThrough = fullPage ? lastAt : new Date(now.getTime() - WATERMARK_OVERLAP_MS).toISOString();
    const nextThroughId = fullPage ? messages.records[messages.records.length - 1]!.get('id') as string : null;

    const shares = await tx.run(
      `MATCH (chat:OpenChatImportedChat)-[s:SHARED_INTO]->(c:Conversation {id: $conversationId})
       WHERE chat.ownerUserId = s.sharedBy AND coalesce(s.indexedImportCount, -1) <> coalesce(chat.importCount, 0)
       MATCH (sharer:User {id: s.sharedBy})-[:PARTICIPATES_IN]->(c)
       OPTIONAL MATCH (m:OpenChatImportedMessage {chatId: chat.id, ownerUserId: chat.ownerUserId})
       OPTIONAL MATCH (p:OpenChatImportedParticipant {chatId: chat.id, ownerUserId: chat.ownerUserId, id: m.senderParticipantId})
       RETURN s.id AS shareId, s.resourceOccurrenceKeys AS previousKeys, chat.network AS network, sharer.id AS sharerId, sharer.name AS sharerName,
              collect({id: m.id, text: m.text, at: m.sentAt, deleted: m.deletedAtSource, participant: p { .id, .displayName, .ordinal, .isOwner }}) AS messages`,
      { conversationId });
    for (const share of shares.records) {
      for (const key of (share.get('previousKeys') as string[] | null) ?? []) affected.add(key);
      const keys: string[] = [];
      for (const message of share.get('messages') as Array<Record<string, unknown>>) {
        if (!message.id) continue;
        const occurrenceKey = `i:${message.id as string}`;
        keys.push(occurrenceKey); affected.add(occurrenceKey);
        const p = message.participant as Record<string, unknown> | null;
        const isSharer = p?.isOwner === true;
        collect(pending, conversationId, message.deleted ? null : message.text as string | null, {
          at: message.at as string, source: share.get('network') as string, occurrenceKey,
          byUserId: isSharer ? share.get('sharerId') as string : null,
          byLabel: isSharer ? (share.get('sharerName') as string | null) ?? null : p ? participantLabel(p as { id: string; displayName?: string | null; ordinal?: unknown }) : null,
        });
      }
      await tx.run('MATCH (chat:OpenChatImportedChat)-[s:SHARED_INTO]->(:Conversation {id: $conversationId}) WHERE s.id = $shareId SET s.indexedImportCount = coalesce(chat.importCount, 0), s.resourceOccurrenceKeys = $keys', { conversationId, shareId: share.get('shareId'), keys });
    }

    if (affected.size) {
      const live = [...pending.values()].flatMap(entry => entry.occurrences.map(o => ({ resourceKey: entry.resourceKey, occurrenceKey: o.occurrenceKey })));
      await tx.run(
        `MATCH (r:ConversationResource {conversationId: $conversationId})
         WHERE any(key IN r.occurrenceKeys WHERE key IN $affected)
         SET r.occurrenceKeys = [key IN r.occurrenceKeys WHERE NOT key IN $affected OR any(item IN $live WHERE item.resourceKey = r.resourceKey AND item.occurrenceKey = key)]
         SET r.shareCount = size(r.occurrenceKeys)
         WITH r WHERE size(r.occurrenceKeys) = 0 DETACH DELETE r`,
        { conversationId, affected: [...affected], live });
    }

    for (const entry of pending.values()) {
      const guess = inferResource({ url: entry.url });
      await tx.run(
        `MERGE (r:ConversationResource {resourceKey: $resourceKey})
         ON CREATE SET r.id = $id, r.conversationId = $conversationId, r.url = $url, r.urlKey = $urlKey, r.host = $host, r.kind = $kind,
           r.tags = $tags, r.suggestedTags = $tags, r.createdAt = $now, r.occurrenceKeys = [], r.sources = [], r.shareCount = 0
         WITH r, [o IN $occurrences WHERE NOT o.occurrenceKey IN r.occurrenceKeys] AS fresh
         WHERE size(fresh) > 0
         WITH r, fresh, head(fresh) AS first, last(fresh).at AS last
         WITH r, fresh, first, last, (r.firstSharedAt IS NULL OR first.at < r.firstSharedAt) AS earlier
         SET r.occurrenceKeys = r.occurrenceKeys + [o IN fresh | o.occurrenceKey],
             r.shareCount = r.shareCount + size(fresh),
             r.sources = r.sources + [source IN $sources WHERE NOT source IN r.sources],
             r.firstSharedAt = CASE WHEN earlier THEN first.at ELSE r.firstSharedAt END,
             r.firstSharedByLabel = CASE WHEN earlier THEN first.byLabel ELSE r.firstSharedByLabel END,
             r.firstSharedByUserId = CASE WHEN earlier THEN first.byUserId ELSE r.firstSharedByUserId END,
             r.lastSharedAt = CASE WHEN r.lastSharedAt IS NULL OR last > r.lastSharedAt THEN last ELSE r.lastSharedAt END,
             r.updatedAt = $now`,
        {
          resourceKey: entry.resourceKey, id: nanoid(), conversationId, url: entry.url, urlKey: entry.urlKey, host: entry.host, kind: guess.kind, tags: guess.suggestedTags,
          now: now.toISOString(),
          occurrences: [...entry.occurrences].sort((x, y) => x.at.localeCompare(y.at)).map(o => ({ occurrenceKey: o.occurrenceKey, at: o.at, byLabel: o.byLabel, byUserId: o.byUserId })),
          sources: [...new Set(entry.occurrences.map(o => o.source))],
        });
    }
    await tx.run('MATCH (c:Conversation {id: $conversationId}) SET c.resourcesIndexedThrough = $through, c.resourcesIndexedThroughId = $throughId REMOVE c.resourcesLockedAt', { conversationId, through: nextThrough, throughId: nextThroughId });
    return fullPage;
  });
}

// ── Page titles and a better guess ────────────────────────────────────────────

const enriching = new Map<string, Promise<void>>();

async function enrichOnce(conversationId: string): Promise<void> {
  const retryBefore = new Date(Date.now() - RETRY_FAILED_AFTER_MS).toISOString();
  const due = await read(async tx => (await tx.run(
    `MATCH (r:ConversationResource {conversationId: $conversationId})
     WHERE r.previewFetchedAt IS NULL OR (r.previewStatus = 'failed' AND r.previewFetchedAt < $retryBefore)
     RETURN r.id AS id, r.url AS url ORDER BY r.lastSharedAt DESC LIMIT $limit`,
    { conversationId, retryBefore, limit: neo4j.int(LIMITS.enrichBatch) })).records.map(record => ({ id: record.get('id') as string, url: record.get('url') as string })));
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const item = due[next++]!;
      let preview: Awaited<ReturnType<PreviewFetcher>> = null;
      try { preview = await previewFetcher(item.url); } catch { preview = null; }
      const clip = (value: string | null | undefined, max: number) => value ? value.replace(/\s+/g, ' ').trim().slice(0, max) || null : null;
      const title = clip(preview?.title, LIMITS.title), description = clip(preview?.description, LIMITS.description), siteName = clip(preview?.siteName, 120);
      const guess = inferResource({ url: item.url, title, description, siteName });
      await write(tx => tx.run(
        `MATCH (r:ConversationResource {id: $id})
         SET r.title = coalesce($title, r.title), r.description = coalesce($description, r.description), r.siteName = coalesce($siteName, r.siteName),
             r.previewFetchedAt = $now, r.previewStatus = $status, r.suggestedTags = $tags,
             r.tags = CASE WHEN r.tagsEditedAt IS NULL THEN $tags ELSE r.tags END,
             r.kind = CASE WHEN r.kindEditedAt IS NULL THEN $kind ELSE r.kind END`,
        { id: item.id, title, description, siteName, now: new Date().toISOString(), status: preview ? 'ok' : 'failed', tags: guess.suggestedTags, kind: guess.kind }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMITS.enrichConcurrency, due.length) }, worker));
}

/** Fetch page titles for entries that have none yet. One run per conversation at a time; never throws. */
function enrich(conversationId: string): Promise<void> {
  const running = enriching.get(conversationId);
  if (running) return running;
  const run = enrichOnce(conversationId).catch(error => { console.warn('[resources] enrichment failed:', error instanceof Error ? error.message : 'unknown error'); }).finally(() => { enriching.delete(conversationId); });
  enriching.set(conversationId, run);
  return run;
}

// ── Reading and editing ───────────────────────────────────────────────────────

const RESOURCE = 'r { .id, .url, .host, .kind, .kindEditedAt, .title, .description, .siteName, .tags, .suggestedTags, .tagsEditedAt, .firstSharedAt, .lastSharedAt, .firstSharedByLabel, .firstSharedByUserId, .shareCount, .sources, .previewFetchedAt } AS r';

function view(r: Record<string, unknown>, saved: boolean, savedCount: number): ResourceView {
  return {
    id: r.id as string, url: r.url as string, host: r.host as string, kind: isResourceKind(r.kind) ? r.kind : 'link', kindEdited: !!r.kindEditedAt,
    title: (r.title as string) ?? null, description: (r.description as string) ?? null, siteName: (r.siteName as string) ?? null,
    tags: (r.tags as string[]) ?? [], suggestedTags: (r.suggestedTags as string[]) ?? [], tagsEdited: !!r.tagsEditedAt,
    firstSharedAt: (r.firstSharedAt as string) ?? null, lastSharedAt: (r.lastSharedAt as string) ?? null,
    firstSharedBy: { label: (r.firstSharedByLabel as string) ?? null, userId: (r.firstSharedByUserId as string) ?? null },
    shareCount: Number(r.shareCount ?? 0), sources: [...((r.sources as string[]) ?? [])].sort(), saved, savedCount,
  };
}

async function readResources(userId: string, conversationId: string, resourceId?: string, cursor?: [string, string] | null): Promise<{ resources: ResourceView[]; pending: number; nextCursor: string | null }> {
  return read(async tx => {
    const result = await tx.run(
      `MATCH (r:ConversationResource {conversationId: $conversationId}) WHERE ($resourceId IS NULL OR r.id = $resourceId) AND ($cursorAt IS NULL OR r.lastSharedAt < $cursorAt OR (r.lastSharedAt = $cursorAt AND r.id > $cursorId))
       WITH r ORDER BY r.lastSharedAt DESC, r.id LIMIT $limit
       OPTIONAL MATCH (:User {id: $userId})-[mine:SAVED_RESOURCE]->(r)
       CALL { WITH r MATCH (:User)-[s:SAVED_RESOURCE]->(r) RETURN count(s) AS savedCount }
       RETURN ${RESOURCE}, mine IS NOT NULL AS saved, savedCount ORDER BY r.lastSharedAt DESC, r.id`,
      { conversationId, userId, resourceId: resourceId ?? null, cursorAt: cursor?.[0] ?? null, cursorId: cursor?.[1] ?? null, limit: neo4j.int(LIMITS.list + 1) });
    const rows = result.records.map(record => ({ raw: record.get('r') as Record<string, unknown>, saved: record.get('saved') === true, savedCount: Number(record.get('savedCount') ?? 0) }));
    const page = rows.slice(0, LIMITS.list);
    const last = page[page.length - 1]?.raw;
    return { resources: page.map(row => view(row.raw, row.saved, row.savedCount)), pending: page.filter(row => !row.raw.previewFetchedAt).length, nextCursor: rows.length > LIMITS.list && last ? Buffer.from(JSON.stringify([last.lastSharedAt, last.id])).toString('base64url') : null };
  });
}

/** The conversation's link resources for a member, newest share first. */
export async function listConversationResources(userId: string, conversationId: string, before?: unknown): Promise<ResourceList> {
  let cursor: [string, string] | null = null;
  if (before !== undefined && before !== '') {
    try { const value = JSON.parse(Buffer.from(String(before), 'base64url').toString('utf8')); if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) cursor = value; } catch { /* invalid */ }
    if (!cursor) fail(400, 'Invalid cursor');
  }
  const member = await read(tx => requireMember(tx, userId, conversationId));
  if (!member.resourcesEnabled) return { enabled: false, resources: [], pending: 0, nextCursor: null, indexingPending: false };
  let indexingPending = false;
  for (let batch = 0; batch < LIMITS.scanBatches; batch++) {
    indexingPending = await indexConversation(conversationId);
    if (!indexingPending) break;
  }
  // Wait briefly for page titles, then answer with what is known; the rest finishes in the background.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([enrich(conversationId), new Promise<void>(resolve => { timer = setTimeout(resolve, LIMITS.enrichBudgetMs); })]);
  if (timer) clearTimeout(timer);
  return { enabled: true, indexingPending, ...(await readResources(userId, conversationId, undefined, cursor)) };
}

async function requireEnabledMember(tx: ManagedTransaction, userId: string, conversationId: string): Promise<void> {
  const member = await requireMember(tx, userId, conversationId);
  if (!member.resourcesEnabled) fail(404, 'Resource not found');
}

/** Any member may correct the tags or the kind; the edit is shared and replaces the guess. */
export async function updateConversationResource(userId: string, conversationId: string, resourceId: string, body: unknown): Promise<ResourceView> {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  let tags: string[] | null = null;
  let kind: ResourceKind | null = null;
  try {
    if (input.tags !== undefined) tags = normalizeTags(input.tags);
  } catch (error) { if (error instanceof ResourceInputError) fail(400, error.message); throw error; }
  if (input.kind !== undefined) { if (!isResourceKind(input.kind)) fail(400, 'Unknown kind'); kind = input.kind as ResourceKind; }
  if (tags === null && kind === null) fail(400, 'Nothing to change: send tags or kind');
  const now = new Date().toISOString();
  await write(async tx => {
    await requireEnabledMember(tx, userId, conversationId);
    const result = await tx.run(
      `MATCH (r:ConversationResource {id: $resourceId, conversationId: $conversationId})
       SET r.tags = CASE WHEN $tags IS NULL THEN r.tags ELSE $tags END,
           r.tagsEditedAt = CASE WHEN $tags IS NULL THEN r.tagsEditedAt ELSE $now END,
           r.tagsEditedBy = CASE WHEN $tags IS NULL THEN r.tagsEditedBy ELSE $userId END,
           r.kind = CASE WHEN $kind IS NULL THEN r.kind ELSE $kind END,
           r.kindEditedAt = CASE WHEN $kind IS NULL THEN r.kindEditedAt ELSE $now END,
           r.kindEditedBy = CASE WHEN $kind IS NULL THEN r.kindEditedBy ELSE $userId END,
           r.updatedAt = $now
       RETURN r.id AS id`, { resourceId, conversationId, tags, kind, now, userId });
    if (!result.records.length) fail(404, 'Resource not found');
  });
  return (await readResources(userId, conversationId, resourceId)).resources[0] ?? fail(404, 'Resource not found');
}

/** A member's own saved mark. Other members see only the count. */
export async function setConversationResourceSaved(userId: string, conversationId: string, resourceId: string, body: unknown): Promise<ResourceView> {
  const saved = body && typeof body === 'object' ? (body as Record<string, unknown>).saved : undefined;
  if (typeof saved !== 'boolean') fail(400, 'saved must be true or false');
  await write(async tx => {
    await requireEnabledMember(tx, userId, conversationId);
    const result = await tx.run(
      saved
        ? `MATCH (u:User {id: $userId}), (r:ConversationResource {id: $resourceId, conversationId: $conversationId})
           MERGE (u)-[s:SAVED_RESOURCE]->(r) ON CREATE SET s.savedAt = $now RETURN r.id AS id`
        : `MATCH (r:ConversationResource {id: $resourceId, conversationId: $conversationId})
           OPTIONAL MATCH (:User {id: $userId})-[s:SAVED_RESOURCE]->(r) DELETE s RETURN r.id AS id`,
      { userId, resourceId, conversationId, now: new Date().toISOString() });
    if (!result.records.length) fail(404, 'Resource not found');
  });
  return (await readResources(userId, conversationId, resourceId)).resources[0] ?? fail(404, 'Resource not found');
}
