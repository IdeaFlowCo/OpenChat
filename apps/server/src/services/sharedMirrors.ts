/**
 * Sharing one imported chat mirror into a group conversation (OpenChat-c8to.1/.2).
 *
 * An imported chat stays its owner's private copy (docs/imported-chat-mirrors.md)
 * until the owner explicitly shares it into a group conversation they own. From
 * then on the members of that conversation can read the mirror's messages and
 * participant names next to the group's own messages. Nothing is copied: the
 * share is one `SHARED_INTO` relationship, access is checked against live
 * membership on every read, and unsharing or deleting the mirror ends it.
 *
 * Still never shared: asks, profile facts, the owner's ask statuses, source
 * keys, and every other imported chat. Imported messages stay under their own
 * labels, so sockets, push, unread counts, search, agents and Context still do
 * not see them.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { importChat, ImportedChatError, listImportedMessages, participantLabel, type ImportedMessageView, type ImportResult } from './importedChats.js';

const fail = (status: number, message: string, details?: Record<string, unknown>): never => { throw new ImportedChatError(status, message, details); };
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const SYNC_TOKEN_PREFIX = 'ocm_';

async function read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try { return await session.executeRead(work); } finally { await session.close(); }
}
async function write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try { return await session.executeWrite(work); } finally { await session.close(); }
}

// ── Owner: share, unshare, list ───────────────────────────────────────────────

export interface MirrorShare { id: string; chatId: string; conversationId: string; conversationTitle: string | null; sharedAt: string }

const conversationIdOf = (body: unknown): string => {
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).conversationId : undefined;
  if (typeof id !== 'string' || !id || id.length > 200) fail(400, 'conversationId is required');
  return id as string;
};

/**
 * Share the owner's imported chat into a group conversation the owner owns.
 * Idempotent. Also turns on the conversation's link resources.
 */
export async function shareImportedChat(ownerUserId: string, chatId: string, body: unknown): Promise<{ share: MirrorShare; created: boolean }> {
  const conversationId = conversationIdOf(body);
  const now = new Date().toISOString();
  return write(async tx => {
    const chat = await tx.run('MATCH (chat:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId}) RETURN chat.id AS id', { chatId, ownerUserId });
    if (!chat.records.length) fail(404, 'Imported chat not found');
    const conversation = await tx.run(
      'MATCH (:User {id: $ownerUserId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN c.type AS type, rel.role AS role, c.title AS title',
      { ownerUserId, conversationId });
    const row = conversation.records[0];
    if (!row) fail(404, 'Conversation not found');
    if (row!.get('type') !== 'group') fail(400, 'An imported chat can only be shared into a group conversation');
    if (row!.get('role') !== 'owner') fail(400, 'Only the group owner can share an imported chat into it');
    const result = await tx.run(
      `MATCH (chat:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId}), (c:Conversation {id: $conversationId})
       MERGE (chat)-[s:SHARED_INTO]->(c)
       ON CREATE SET s.id = $id, s.sharedBy = $ownerUserId, s.sharedAt = $now, s.created = true
       SET c.resourcesEnabled = true
       WITH s, s.created AS created
       REMOVE s.created
       RETURN s.id AS id, s.sharedAt AS sharedAt, coalesce(created, false) AS created`,
      { chatId, ownerUserId, conversationId, id: nanoid(), now });
    const saved = result.records[0]!;
    return { share: { id: saved.get('id'), chatId, conversationId, conversationTitle: (row!.get('title') as string | null) ?? null, sharedAt: saved.get('sharedAt') }, created: saved.get('created') === true };
  });
}

/** Stop sharing. Members lose the mirror at once; link resources already collected stay with the conversation. */
export async function unshareImportedChat(ownerUserId: string, chatId: string, conversationId: string): Promise<{ unshared: boolean }> {
  return write(async tx => {
    const result = await tx.run(
      'MATCH (:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId})-[s:SHARED_INTO]->(:Conversation {id: $conversationId}) DELETE s RETURN count(*) AS removed',
      { chatId, ownerUserId, conversationId });
    return { unshared: Number(result.records[0]?.get('removed') ?? 0) > 0 };
  });
}

export async function listImportedChatShares(ownerUserId: string, chatId: string): Promise<{ shares: MirrorShare[]; syncToken: { active: boolean; createdAt: string | null; lastUsedAt: string | null } }> {
  return read(async tx => {
    const chat = await tx.run('MATCH (chat:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId}) RETURN chat { .syncTokenHash, .syncTokenCreatedAt, .syncTokenLastUsedAt } AS chat', { chatId, ownerUserId });
    if (!chat.records.length) fail(404, 'Imported chat not found');
    const stored = chat.records[0]!.get('chat') as Record<string, unknown>;
    const result = await tx.run(
      `MATCH (:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId})-[s:SHARED_INTO]->(c:Conversation)
       RETURN s.id AS id, c.id AS conversationId, c.title AS title, s.sharedAt AS sharedAt ORDER BY s.sharedAt`,
      { chatId, ownerUserId });
    return {
      shares: result.records.map(record => ({ id: record.get('id'), chatId, conversationId: record.get('conversationId'), conversationTitle: (record.get('title') as string | null) ?? null, sharedAt: record.get('sharedAt') })),
      syncToken: { active: !!stored.syncTokenHash, createdAt: (stored.syncTokenCreatedAt as string) ?? null, lastUsedAt: (stored.syncTokenLastUsedAt as string) ?? null },
    };
  });
}

// ── Members: read what was shared into their conversation ────────────────────

export interface SourceParticipant { participantId: string; label: string; isSharer: boolean }
export interface ConversationSource {
  id: string;
  network: string;
  title: string;
  sharedAt: string;
  sharedBy: { userId: string; name: string | null };
  coverage: { asOf: string | null; earliestMessageAt: string | null; latestMessageAt: string | null; complete: boolean };
  messageCount: number;
  participants: SourceParticipant[];
}
export interface ConversationSources { sources: ConversationSource[]; resourcesEnabled: boolean }

/** 404 unless `userId` is in the conversation. Returns the conversation's flags. */
export async function requireMember(tx: ManagedTransaction, userId: string, conversationId: string): Promise<{ role: string; resourcesEnabled: boolean }> {
  const result = await tx.run(
    'MATCH (:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN rel.role AS role, coalesce(c.resourcesEnabled, false) AS resourcesEnabled',
    { userId, conversationId });
  const row = result.records[0];
  if (!row) fail(404, 'Conversation not found');
  return { role: (row!.get('role') as string) ?? 'member', resourcesEnabled: row!.get('resourcesEnabled') === true };
}

/**
 * The shares a member may read: the sharer must still be in the conversation,
 * so a mirror never outlives its owner's membership.
 */
const ACTIVE_SHARES = `
  MATCH (chat:OpenChatImportedChat)-[s:SHARED_INTO]->(c:Conversation {id: $conversationId})
  WHERE chat.ownerUserId = s.sharedBy AND EXISTS { MATCH (:User {id: s.sharedBy})-[:PARTICIPATES_IN]->(c) }`;

export async function listConversationSources(userId: string, conversationId: string): Promise<ConversationSources> {
  return read(async tx => {
    const member = await requireMember(tx, userId, conversationId);
    const result = await tx.run(
      `${ACTIVE_SHARES}
       MATCH (sharer:User {id: s.sharedBy})
       CALL { WITH chat MATCH (m:OpenChatImportedMessage {chatId: chat.id, ownerUserId: chat.ownerUserId}) RETURN count(m) AS messageCount }
       CALL { WITH chat MATCH (p:OpenChatImportedParticipant {chatId: chat.id, ownerUserId: chat.ownerUserId}) WITH p ORDER BY p.ordinal RETURN collect(p { .id, .displayName, .ordinal, .isOwner }) AS participants }
       RETURN s.id AS id, s.sharedAt AS sharedAt, sharer.id AS sharerId, sharer.name AS sharerName, messageCount, participants,
              chat { .network, .title, .asOf, .earliestMessageAt, .latestMessageAt, .complete } AS chat
       ORDER BY s.sharedAt`,
      { conversationId });
    return {
      resourcesEnabled: member.resourcesEnabled,
      sources: result.records.map(record => {
        const chat = record.get('chat') as Record<string, unknown>;
        const participants = record.get('participants') as Array<Record<string, unknown>>;
        return {
          id: record.get('id') as string,
          network: chat.network as string,
          title: (chat.title as string) ?? '',
          sharedAt: record.get('sharedAt') as string,
          sharedBy: { userId: record.get('sharerId') as string, name: (record.get('sharerName') as string | null) ?? null },
          coverage: { asOf: (chat.asOf as string) ?? null, earliestMessageAt: (chat.earliestMessageAt as string) ?? null, latestMessageAt: (chat.latestMessageAt as string) ?? null, complete: chat.complete === true },
          messageCount: Number(record.get('messageCount') ?? 0),
          participants: participants.map(p => ({ participantId: p.id as string, label: participantLabel({ id: p.id as string, displayName: p.displayName as string | null, ordinal: p.ordinal }), isSharer: p.isOwner === true })),
        };
      }),
    };
  });
}

/** The mirror behind one share, for a member; 404 when the share is not readable by them. */
async function resolveShare(userId: string, conversationId: string, shareId: string): Promise<{ chatId: string; ownerUserId: string }> {
  return read(async tx => {
    await requireMember(tx, userId, conversationId);
    const result = await tx.run(`${ACTIVE_SHARES} AND s.id = $shareId RETURN chat.id AS chatId, chat.ownerUserId AS ownerUserId`, { conversationId, shareId });
    const row = result.records[0];
    if (!row) fail(404, 'Shared chat not found');
    return { chatId: row!.get('chatId') as string, ownerUserId: row!.get('ownerUserId') as string };
  });
}

/** What a member sees of a mirrored message: no source ids and no pre-edit text. */
export type SharedMessage = Pick<ImportedMessageView, 'id' | 'sentAt' | 'kind' | 'text' | 'mediaType' | 'edited' | 'editedAt' | 'deletedAtSource'> & { sender: SourceParticipant | null };

export async function listSourceMessages(userId: string, conversationId: string, shareId: string, query: { before?: unknown; limit?: unknown }): Promise<{ messages: SharedMessage[]; nextCursor: string | null }> {
  const { chatId, ownerUserId } = await resolveShare(userId, conversationId, shareId);
  let before: string | undefined;
  if (query.before !== undefined && query.before !== '') {
    let id: unknown;
    try { id = JSON.parse(Buffer.from(String(query.before), 'base64url').toString('utf8')); } catch { fail(400, 'Invalid cursor'); }
    if (typeof id !== 'string' || !id || id.length > 200) fail(400, 'Invalid cursor');
    const row = await read(tx => tx.run('MATCH (m:OpenChatImportedMessage {id: $id, chatId: $chatId, ownerUserId: $ownerUserId}) RETURN m.sentAt AS sentAt, m.sourceMessageId AS sourceMessageId', { id, chatId, ownerUserId }));
    if (!row.records.length) fail(400, 'Invalid cursor');
    before = Buffer.from(JSON.stringify([row.records[0]!.get('sentAt'), row.records[0]!.get('sourceMessageId')])).toString('base64url');
  }
  const page = await listImportedMessages(ownerUserId, chatId, { before, limit: query.limit });
  const last = page.messages[page.messages.length - 1];
  return {
    nextCursor: page.nextCursor && last ? Buffer.from(JSON.stringify(last.id)).toString('base64url') : null,
    messages: page.messages.map(m => ({
      id: m.id, sentAt: m.sentAt, kind: m.kind, text: m.text, mediaType: m.mediaType, edited: m.edited, editedAt: m.editedAt, deletedAtSource: m.deletedAtSource,
      sender: m.sender ? { participantId: m.sender.participantId, label: m.sender.label, isSharer: m.sender.isOwner } : null,
    })),
  };
}

// ── One-chat sync token ───────────────────────────────────────────────────────

/**
 * Issue the write-only token a companion uses to keep this one mirror current.
 * Replaces any earlier token. Only its SHA-256 is stored; the token is shown once.
 */
export async function createSyncToken(ownerUserId: string, chatId: string): Promise<{ token: string; createdAt: string }> {
  const token = `${SYNC_TOKEN_PREFIX}${nanoid(48)}`;
  const createdAt = new Date().toISOString();
  return write(async tx => {
    const result = await tx.run(
      `MATCH (chat:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId})
       SET chat.syncTokenHash = $hash, chat.syncTokenCreatedAt = $createdAt, chat.syncTokenLastUsedAt = null
       RETURN chat.id AS id`,
      { chatId, ownerUserId, hash: sha256(token).toString('hex'), createdAt });
    if (!result.records.length) fail(404, 'Imported chat not found');
    return { token, createdAt };
  });
}

export async function revokeSyncToken(ownerUserId: string, chatId: string): Promise<{ revoked: boolean }> {
  return write(async tx => {
    const result = await tx.run(
      `MATCH (chat:OpenChatImportedChat {id: $chatId, ownerUserId: $ownerUserId})
       WITH chat, chat.syncTokenHash IS NOT NULL AS had
       REMOVE chat.syncTokenHash, chat.syncTokenCreatedAt, chat.syncTokenLastUsedAt
       RETURN had`,
      { chatId, ownerUserId });
    if (!result.records.length) fail(404, 'Imported chat not found');
    return { revoked: result.records[0]!.get('had') === true };
  });
}

/** The bearer token from an Authorization header, if it is a sync token. */
export function syncTokenFrom(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match && match[1]!.startsWith(SYNC_TOKEN_PREFIX) && match[1]!.length <= 200 ? match[1]! : null;
}

/**
 * Which mirror a sync token may write, or null. Looked up by chat id and then
 * compared in constant time, so a token for one chat is useless for another.
 */
export async function authenticateSyncToken(chatId: string, token: string): Promise<{ ownerUserId: string; network: string; accountKey: string; chatKey: string } | null> {
  const stored = await read(async tx => {
    const result = await tx.run('MATCH (chat:OpenChatImportedChat {id: $chatId}) RETURN chat { .ownerUserId, .network, .accountKey, .chatKey, .syncTokenHash } AS chat', { chatId });
    return result.records[0]?.get('chat') as Record<string, unknown> | undefined;
  });
  const expected = typeof stored?.syncTokenHash === 'string' ? Buffer.from(stored.syncTokenHash, 'hex') : null;
  const given = sha256(token);
  if (!stored || !expected || expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { ownerUserId: stored.ownerUserId as string, network: stored.network as string, accountKey: stored.accountKey as string, chatKey: stored.chatKey as string };
}

/**
 * Apply a companion's sync to the one mirror its token names. The payload must
 * be for that same source chat and may carry only participants and messages:
 * a sync token can never add asks or profile facts, or touch another chat.
 */
export async function syncImportedChat(chatId: string, grant: { ownerUserId: string; network: string; accountKey: string; chatKey: string }, body: unknown, options: { dryRun?: boolean }): Promise<ImportResult> {
  const root = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const source = root && root.source && typeof root.source === 'object' ? root.source as Record<string, unknown> : null;
  if (!source || source.network !== grant.network || source.accountKey !== grant.accountKey || source.chatKey !== grant.chatKey) fail(400, 'This token can only sync the chat it was issued for', { errors: [{ path: 'source', message: 'does not match the mirrored chat' }] });
  if (Array.isArray(root!.asks) && root!.asks.length) fail(400, 'A sync cannot carry asks', { errors: [{ path: 'asks', message: 'must be empty' }] });
  const participants = Array.isArray(root!.participants) ? root!.participants as Array<Record<string, unknown> | null> : [];
  if (participants.some(p => p && Array.isArray(p.profileFacts) && p.profileFacts.length)) fail(400, 'A sync cannot carry profile facts', { errors: [{ path: 'participants', message: 'profileFacts must be empty' }] });
  const result = await importChat(grant.ownerUserId, body, { dryRun: options.dryRun, importedBy: 'sync-token' });
  if (!options.dryRun) {
    await write(tx => tx.run('MATCH (chat:OpenChatImportedChat {id: $chatId}) SET chat.syncTokenLastUsedAt = $now', { chatId, now: new Date().toISOString() }));
  }
  return result;
}
