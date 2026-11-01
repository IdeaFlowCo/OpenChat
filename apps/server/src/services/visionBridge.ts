/* eslint-disable no-control-regex -- Reject control characters in partner-supplied identifiers. */
/**
 * OpenChat ↔ Vision bridge (OpenChat-vwgq.9–.12, OpenChat-3kr.9).
 *
 * - Partner session: Vision's server exchanges a verified Ideaflow identity for a
 *   short-lived session of the EXISTING OpenChat account bound to that identity.
 * - Message provenance: a Vision-sent message records which note it came from.
 * - Reply delivery: a reply to such a message is delivered back to Vision through
 *   a durable Neo4j outbox.
 * - Reserved handles: `agent` resolves to the caller's own assistant DM.
 * - Stream search: the owner's Vision notes, read through the hub's read bridge.
 *
 * Contract shared with notestream-vision: docs/shared-capabilities-control.md
 * ("Vision stream bridge").
 */
import { createHash } from 'node:crypto';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { readApp, type AppIdentity } from './appSources.js';

export const VISION_ISSUER = 'https://id.ideaflow.app/api/auth';
const controlChars = /[\x00-\x1f\x7f]/;

export function validSubject(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !controlChars.test(value);
}

// ─── Reserved handles ────────────────────────────────────────────────────────

/** The owner's own assistant. Jacob may rename it; the resolver and the reserved
 * list both read this constant. */
export const AGENT_HANDLE = 'agent';
export const AGENT_HANDLE_DISPLAY_NAME = 'Your agent';
/** Handles no account may ever claim (OpenChat-3ag.10 builds the username UI). */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([AGENT_HANDLE, 'openchat', 'assistant', 'system', 'support', 'feedback']);
export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}
export function isReservedUsername(value: string): boolean {
  return RESERVED_USERNAMES.has(normalizeHandle(value));
}

// ─── Message provenance ──────────────────────────────────────────────────────

export type MessageProvenance = {
  service: 'vision';
  noteId: string;
  noteRevision?: number;
  loopId?: string;
  ownerSubject: string;
};
const refPattern = /^[A-Za-z0-9._:-]{1,200}$/;

/** `undefined`/`null` → no provenance; anything malformed → `'invalid'`. */
export function parseMessageProvenance(value: unknown): MessageProvenance | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['service', 'noteId', 'noteRevision', 'loopId', 'ownerSubject'].includes(key))) return 'invalid';
  if (v.service !== 'vision' || typeof v.noteId !== 'string' || !refPattern.test(v.noteId) || !validSubject(v.ownerSubject)) return 'invalid';
  if (v.noteRevision !== undefined && (!Number.isSafeInteger(v.noteRevision) || (v.noteRevision as number) < 0)) return 'invalid';
  if (v.loopId !== undefined && (typeof v.loopId !== 'string' || !refPattern.test(v.loopId))) return 'invalid';
  return {
    service: 'vision', noteId: v.noteId, ownerSubject: v.ownerSubject as string,
    ...(v.noteRevision !== undefined ? { noteRevision: v.noteRevision as number } : {}),
    ...(v.loopId !== undefined ? { loopId: v.loopId as string } : {}),
  };
}

/** Provenance names the sender's own note: its owner must be the sender's own
 * Ideaflow identity, so nobody can route replies into another person's Vision. */
export async function provenanceBelongsToSender(session: Pick<Session, 'run'>, senderId: string, provenance: MessageProvenance): Promise<boolean> {
  const result = await session.run('MATCH (u:User {id:$senderId}) RETURN u.ideaflowIssuer AS issuer,u.ideaflowSub AS subject', { senderId });
  const row = result.records[0];
  return row?.get('issuer') === VISION_ISSUER && row.get('subject') === provenance.ownerSubject;
}

// ─── Reply delivery to Vision ────────────────────────────────────────────────

export const REPLY_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
export function replyBackoff(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}
export function visionReplyDeliveryConfigured(): boolean {
  const secret = process.env.OPENCHAT_VISION_SECRET;
  return !!secret && secret.length >= 32 && /^https:\/\//.test(process.env.VISION_API_BASE ?? '');
}

/**
 * Enqueue one delivery when `messageId` replies to a Vision-provenance message.
 * Idempotent by the reply's messageId. The payload is snapshotted now so later
 * edits or deletions never change what Vision was told.
 */
export async function enqueueVisionReply(tx: Pick<ManagedTransaction, 'run'>, messageId: string): Promise<boolean> {
  const source = await tx.run(`MATCH (m:Message {id:$messageId})
    WHERE m.replyToId IS NOT NULL AND m.deletedAt IS NULL
    MATCH (target:Message {id:m.replyToId, conversationId:m.conversationId})
    WHERE target.provenanceService = 'vision'
    MATCH (p:MessageProvenance {messageId:target.id})
    // Only while the owner still belongs to the chat, and never across a block.
    MATCH (owner:User {id:target.senderId})-[:PARTICIPATES_IN]->(:Conversation {id:m.conversationId})
    OPTIONAL MATCH (sender:User {id:m.senderId})
    WITH m, target, p, sender, owner
    WHERE sender IS NULL OR sender = owner OR NOT ((owner)-[:BLOCKED]->(sender) OR (sender)-[:BLOCKED]->(owner))
    RETURN p.json AS provenance, target.senderId AS ownerUserId, target.id AS repliedToMessageId,
      m.conversationId AS conversationId, m.senderId AS senderUserId, coalesce(sender.name, '') AS senderName,
      coalesce(m.content, m.transcript, '') AS content, toString(m.createdAt) AS createdAt`, { messageId });
  const row = source.records[0];
  if (!row) return false;
  const provenance = parseMessageProvenance(JSON.parse(row.get('provenance')));
  if (!provenance || provenance === 'invalid') return false;
  const payload = visionReplyPayload(provenance, {
    messageId, conversationId: row.get('conversationId'), senderUserId: row.get('senderUserId'),
    senderName: row.get('senderName'), content: row.get('content'), createdAt: row.get('createdAt'),
  }, row.get('repliedToMessageId'));
  const now = new Date().toISOString();
  // Idempotent by the reply's messageId: a re-enqueue never replaces the snapshot.
  await tx.run(`MERGE (d:VisionReplyDelivery {messageId:$messageId})
    ON CREATE SET d.id=$id,d.status='pending',d.attempts=0,d.createdAt=$now,d.nextAttemptAt=$now,
      d.expiresAt=$expiresAt,d.ownerUserId=$ownerUserId,d.payload=$payload`,
  { messageId, id: nanoid(), now, expiresAt: new Date(Date.now() + REPLY_DELIVERY_TTL_MS).toISOString(), ownerUserId: row.get('ownerUserId'), payload: JSON.stringify(payload) });
  return true;
}

export type VisionReplyPayload = {
  noteId: string;
  loopId: string | null;
  ownerSubject: string;
  reply: { messageId: string; conversationId: string; senderUserId: string; senderName: string; content: string; createdAt: string };
  repliedToMessageId: string;
};
export function visionReplyPayload(provenance: MessageProvenance, reply: VisionReplyPayload['reply'], repliedToMessageId: string): VisionReplyPayload {
  return { noteId: provenance.noteId, loopId: provenance.loopId ?? null, ownerSubject: provenance.ownerSubject, reply, repliedToMessageId };
}

/** Best-effort enqueue after a message is persisted; never breaks a send. */
export function scheduleVisionReplyDelivery(messageId: string, replyToId: unknown): void {
  if (typeof replyToId !== 'string' || !replyToId) return;
  const session = getDriver().session();
  void session.executeWrite(tx => enqueueVisionReply(tx, messageId))
    .catch(() => console.warn('[vision-replies] enqueue deferred'))
    .finally(() => { void session.close(); });
}

export type VisionReplyTransport = (url: string, secret: string, body: string) => Promise<'delivered' | 'retry' | 'rejected'>;
export const postVisionReply: VisionReplyTransport = async (url, secret, body) => {
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body });
  // 2xx = stored (Vision dedupes by reply.messageId). 4xx other than 408/429 is a
  // permanent refusal (unknown note, owner mismatch); retrying cannot fix it.
  if (response.ok) return 'delivered';
  if (response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status)) return 'rejected';
  return 'retry';
};

/** Claims and delivers at most one due delivery. Returns whether one was attempted. */
export async function runVisionReplyOnce(driver: Driver, transport: VisionReplyTransport = postVisionReply, now = () => Date.now()): Promise<boolean> {
  if (!visionReplyDeliveryConfigured()) return false;
  const s = driver.session();
  const token = nanoid();
  try {
    const nowIso = new Date(now()).toISOString();
    const claim = await s.executeWrite(async tx => {
      // Serializes claims across processes (as contextWebhooks does); outbound I/O happens after this short transaction.
      await tx.run(`MERGE (w:VisionReplyWorker {id:'dispatcher'}) SET w.revision=coalesce(w.revision,0)+1`);
      const expired = await tx.run(`MATCH (d:VisionReplyDelivery) WHERE d.status IN ['pending','delivering'] AND d.expiresAt<=$now
        SET d.status='expired',d.finishedAt=$now REMOVE d.leaseToken RETURN d.messageId AS messageId, d.attempts AS attempts`, { now: nowIso });
      for (const row of expired.records) console.warn(`[vision-replies] gave up after 24h: message ${row.get('messageId')} (${Number(row.get('attempts'))} attempts)`);
      const rows = await tx.run(`MATCH (d:VisionReplyDelivery) WHERE d.expiresAt>$now 
        AND ((d.status='pending' AND d.nextAttemptAt<=$now) OR (d.status='delivering' AND d.leaseUntil<=$now))
        WITH d ORDER BY d.nextAttemptAt, d.messageId LIMIT 1
        SET d.status='delivering',d.leaseToken=$token,d.leaseUntil=$until,d.attempts=d.attempts+1
        RETURN d.messageId AS messageId, d.payload AS payload, d.attempts AS attempts`,
      { now: nowIso, token, until: new Date(now() + 60_000).toISOString() });
      const row = rows.records[0];
      return row ? { messageId: row.get('messageId') as string, payload: row.get('payload') as string, attempts: Number(row.get('attempts')) } : null;
    });
    if (!claim) return false;
    let outcome: 'delivered' | 'retry' | 'rejected' = 'retry';
    try { outcome = await transport(`${process.env.VISION_API_BASE!.replace(/\/+$/, '')}/openchat/replies`, process.env.OPENCHAT_VISION_SECRET!, claim.payload); }
    catch { /* Fixed failure category; no endpoint or credentials logged. */ }
    const finishedAt = new Date(now()).toISOString();
    const status = outcome === 'delivered' ? 'delivered' : outcome === 'rejected' ? 'rejected' : 'pending';
    await s.run(`MATCH (d:VisionReplyDelivery {messageId:$messageId, leaseToken:$token})
      SET d.status=$status,d.lastAttemptAt=$now,d.nextAttemptAt=$next,
        d.finishedAt=CASE WHEN $status='pending' THEN null ELSE $now END REMOVE d.leaseToken`,
    { messageId: claim.messageId, token, status, now: finishedAt, next: new Date(now() + replyBackoff(claim.attempts)).toISOString() });
    if (status === 'rejected') console.warn(`[vision-replies] Vision refused message ${claim.messageId}; not retrying`);
    return true;
  } finally { await s.close(); }
}

/**
 * Safety net for the post-commit enqueue (crash or transient write failure):
 * finds recent replies to Vision-sent messages that have no delivery yet.
 * Walks from the few provenance nodes via the indexed conversationId.
 */
export async function reconcileVisionReplies(driver: Driver): Promise<number> {
  const s = driver.session();
  try {
    const rows = await s.run(`MATCH (p:MessageProvenance) WHERE p.createdAt > datetime() - duration('P30D')
      MATCH (target:Message {id:p.messageId})
      MATCH (m:Message {conversationId:target.conversationId})
      WHERE m.replyToId = target.id AND m.createdAt > datetime() - duration('PT23H') AND m.createdAt < datetime() - duration('PT1M')
        AND NOT EXISTS { MATCH (:VisionReplyDelivery {messageId:m.id}) }
      RETURN m.id AS id LIMIT 50`);
    let enqueued = 0;
    for (const row of rows.records) if (await s.executeWrite(tx => enqueueVisionReply(tx, row.get('id')))) enqueued++;
    return enqueued;
  } finally { await s.close(); }
}

export function startVisionReplyWorker(driver: Driver): () => void {
  let stopped = false, busy = false, ticks = 0;
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try {
      if (ticks++ % 720 === 0) {
        const s = driver.session();
        try { await s.run(`MATCH (d:VisionReplyDelivery) WHERE d.finishedAt < $cutoff DETACH DELETE d`, { cutoff: new Date(Date.now() - 7 * 86400_000).toISOString() }); }
        finally { await s.close(); }
      }
      if (ticks % 60 === 1) await reconcileVisionReplies(driver);
      // Drain a small batch per tick; each claim is its own short transaction.
      for (let i = 0; i < 5 && !stopped && await runVisionReplyOnce(driver); i++) { /* next */ }
    } catch { console.warn('[vision-replies] dispatch deferred'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 5000); timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

// ─── Stream search over Vision ───────────────────────────────────────────────

export type VisionSearchChip = 'openchat' | 'all';
export type VisionSearchRow = { id: string; text: string; title: string | null; createdAt: string | null; url: string; sourcePlatform: string | null; sourceLink: string | null; tags: string[] };
export type VisionSearchResult =
  | { status: 'ok'; rows: VisionSearchRow[]; nextCursor: string | null }
  | { status: 'unavailable'; code: 'account_link_required' | 'not_configured' | 'source_unavailable' | 'timeout'; reason: string };
export const VISION_SEARCH_PAGE = 20;
/** Vision's search_notes tool returns at most 25 notes per call. */
const VISION_TOOL_LIMIT = 25;
export const VISION_SEARCH_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: VisionSearchResult }>();
/** Until Vision's `source` predicate ships, the tool rejects unknown arguments. */
let sourcePredicateUnsupportedUntil = 0;
const budgets = new Map<string, { at: number; count: number }>();
export function resetVisionSearchState(): void { cache.clear(); budgets.clear(); sourcePredicateUnsupportedUntil = 0; }
/** 60 Vision searches per user per minute (the debounced client sends far fewer). */
export function takeVisionSearchBudget(userId: string, now = Date.now()): boolean {
  for (const [key, value] of budgets) if (now - value.at >= 60_000) budgets.delete(key);
  const budget = budgets.get(userId) ?? { at: now, count: 0 };
  if (budget.count >= 60 || (budgets.size >= 10_000 && !budgets.has(userId))) return false;
  budget.count++; budgets.set(userId, budget);
  return true;
}

type Cursor = { o: number } | { c: string };
export function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
export function decodeCursor(value: string | undefined): Cursor | null | 'invalid' {
  if (!value) return null;
  if (value.length > 2000) return 'invalid';
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed && Number.isSafeInteger(parsed.o) && parsed.o > 0 && parsed.o < VISION_TOOL_LIMIT) return { o: parsed.o };
    if (parsed && typeof parsed.c === 'string' && parsed.c && parsed.c.length <= 1000) return { c: parsed.c };
  } catch { /* invalid */ }
  return 'invalid';
}

/** Unwrap a hub read-bridge result: MCP tool result or the bare payload. */
function toolPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { result?: unknown; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean; error?: unknown };
  if (v.result && typeof v.result === 'object') return toolPayload(v.result);
  if (v.isError) return null;
  if (v.structuredContent && typeof v.structuredContent === 'object') return v.structuredContent as Record<string, unknown>;
  for (const item of v.content ?? []) if (item?.type === 'text' && item.text) { try { return JSON.parse(item.text); } catch { /* not JSON */ } }
  return value as Record<string, unknown>;
}
function isoTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
const visionUrl = (value: unknown, id: string) => typeof value === 'string' && (value === 'https://vision.ideaflow.app' || value.startsWith('https://vision.ideaflow.app/')) ? value : `https://vision.ideaflow.app/notes/${encodeURIComponent(id)}`;
function plainText(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+\n/g, '\n').trim();
}
export function toSearchRow(note: Record<string, unknown>): VisionSearchRow | null {
  if (typeof note.id !== 'string' || !note.id) return null;
  const body = typeof note.bodyMd === 'string' ? note.bodyMd : typeof note.plainText === 'string' ? note.plainText : typeof note.text === 'string' ? note.text : '';
  const text = plainText(body);
  const firstLine = text.split('\n')[0]?.replace(/^#+\s*/, '').trim() ?? '';
  const tags = Array.isArray(note.hashtags) ? note.hashtags : Array.isArray(note.tags) ? note.tags : [];
  return {
    id: note.id, text: text.slice(0, 2000),
    title: typeof note.title === 'string' && note.title ? note.title.slice(0, 200) : (firstLine ? firstLine.slice(0, 200) : null),
    createdAt: isoTime(note.createdAt), url: visionUrl(note.url, note.id),
    sourcePlatform: typeof note.sourcePlatform === 'string' ? note.sourcePlatform : null,
    sourceLink: typeof note.sourceLink === 'string' ? note.sourceLink : null,
    tags: tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.replace(/^#/, '')).slice(0, 20),
  };
}
/** Client-side origin filter, used until Vision filters by `source` itself. */
export function fromOpenChat(row: VisionSearchRow, rawBody = ''): boolean {
  if (row.sourcePlatform && /^openchat$/i.test(row.sourcePlatform)) return true;
  if (row.sourceLink && (row.sourceLink.startsWith('chat-import://openchat/') || row.sourceLink.startsWith('https://chat.ideaflow.app/'))) return true;
  return rawBody.includes('<!-- openchat-save:') || rawBody.includes('https://chat.ideaflow.app/app/chat/');
}

export type VisionReader = (identity: AppIdentity, tool: string, args: Record<string, unknown>, abort: AbortSignal) => Promise<unknown>;
const defaultReader: VisionReader = (identity, tool, args, abort) => readApp(identity, 'vision', tool, args, abort);

export async function searchVision(userId: string, identity: AppIdentity, q: string, chip: VisionSearchChip, cursor: Cursor | null, reader: VisionReader = defaultReader, timeoutMs = VISION_SEARCH_TIMEOUT_MS): Promise<VisionSearchResult> {
  const key = JSON.stringify([userId, q.toLowerCase(), chip, cursor]);
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.value;
  const abort = AbortSignal.timeout(timeoutMs);
  const call = async (withSource: boolean): Promise<{ payload: Record<string, unknown> | null; error?: string }> => {
    const args: Record<string, unknown> = { query: q, limit: VISION_TOOL_LIMIT, includeBodies: true, visibility: 'my-world',
      ...(withSource ? { source: { platform: 'openchat' } } : {}), ...(cursor && 'c' in cursor ? { cursor: cursor.c } : {}) };
    const raw = await reader(identity, 'search_notes', args, abort);
    const code = raw && typeof raw === 'object' ? (raw as { code?: unknown }).code : undefined;
    if (typeof code === 'string') return { payload: null, error: code };
    return { payload: toolPayload(raw) };
  };
  let result: VisionSearchResult;
  try {
    const wantSource = chip === 'openchat' && Date.now() >= sourcePredicateUnsupportedUntil;
    let filtered = !wantSource && chip === 'openchat';
    let response = await call(wantSource);
    if (wantSource && (response.error === 'source_unavailable' || !Array.isArray(response.payload?.notes)) && !abort.aborted && response.error !== 'account_link_required' && response.error !== 'not_configured') {
      // Maybe an older Vision without the `source` argument: retry without it and
      // filter here. Remember that only when the plain call works, so a transient
      // hub failure never disables the server-side filter for everyone.
      filtered = true;
      response = await call(false);
      if (Array.isArray(response.payload?.notes)) sourcePredicateUnsupportedUntil = Date.now() + 600_000;
    }
    if (abort.aborted) result = { status: 'unavailable', code: 'timeout', reason: 'Vision did not answer in time' };
    else if (response.error === 'account_link_required' || response.error === 'not_configured') result = { status: 'unavailable', code: response.error, reason: response.error === 'not_configured' ? 'Vision search is not configured' : 'Sign into Vision with the same Ideaflow account' };
    else if (!Array.isArray(response.payload?.notes)) result = { status: 'unavailable', code: 'source_unavailable', reason: 'Vision search is unavailable' };
    else {
      const notes = (response.payload!.notes as unknown[]).filter((n): n is Record<string, unknown> => !!n && typeof n === 'object');
      let rows = notes.map(n => ({ row: toSearchRow(n), body: typeof n.bodyMd === 'string' ? n.bodyMd : '' }))
        .filter((r): r is { row: VisionSearchRow; body: string } => !!r.row);
      if (filtered) rows = rows.filter(r => fromOpenChat(r.row, r.body));
      const visionCursor = typeof response.payload!.nextCursor === 'string' && response.payload!.nextCursor ? response.payload!.nextCursor as string : null;
      if (visionCursor) {
        // Vision pages for us: return its whole page so the cursor never skips rows.
        result = { status: 'ok', rows: rows.map(r => r.row), nextCursor: encodeCursor({ c: visionCursor }) };
      } else {
        const offset = cursor && 'o' in cursor ? cursor.o : 0;
        const page = rows.slice(offset, offset + VISION_SEARCH_PAGE).map(r => r.row);
        const next = offset + VISION_SEARCH_PAGE;
        result = { status: 'ok', rows: page, nextCursor: next < rows.length && next < VISION_TOOL_LIMIT ? encodeCursor({ o: next }) : null };
      }
    }
  } catch {
    result = abort.aborted ? { status: 'unavailable', code: 'timeout', reason: 'Vision did not answer in time' } : { status: 'unavailable', code: 'source_unavailable', reason: 'Vision search is unavailable' };
  }
  // Cache successes and stable "no Vision" answers; transient failures retry next time.
  if (result.status === 'ok' || result.code === 'account_link_required' || result.code === 'not_configured') {
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value: result });
  }
  return result;
}

export async function ownIdentity(userId: string): Promise<AppIdentity> {
  const db = getDriver().session({ defaultAccessMode: 'READ' });
  try {
    const rows = await db.run('MATCH (u:User {id:$userId}) RETURN u.ideaflowIssuer AS issuer,u.ideaflowSub AS subject', { userId });
    const row = rows.records[0];
    return row?.get('issuer') === VISION_ISSUER && validSubject(row.get('subject')) ? { issuer: VISION_ISSUER, subject: row.get('subject') } : null;
  } finally { await db.close(); }
}

/** Stable message id for a connector principal's retry key (OpenChat-vwgq.10). */
export function connectorMessageId(userId: string, conversationId: string, clientRequestId: string): string {
  return 'ocu_' + createHash('sha256').update(JSON.stringify(['ideaflow-connector', userId, conversationId, clientRequestId])).digest('hex');
}
