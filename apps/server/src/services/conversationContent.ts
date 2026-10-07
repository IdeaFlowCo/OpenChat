import { createHash } from 'node:crypto';
import type { Session } from 'neo4j-driver';
import { checkContextReadAccess } from './contextAccess.js';
import { ContextLaneError, projectContextPost } from './contextLane.js';

export type ContentFilter = 'all' | 'context' | 'stream';
export interface ConversationContentOptions { filter?: ContentFilter; search?: string; cursor?: string; limit?: number; includePrivate?: boolean; contextAvailable?: boolean }
const asString = (value: any): string | undefined => value == null ? undefined : String(value);
/** A cursor is bound to the viewer and exact query, never an access grant. */
export function contentCursorScope(userId: string, conversationId: string, options: ConversationContentOptions) {
  return createHash('sha256').update(JSON.stringify([userId, conversationId, options.filter || 'all', options.search || '', options.includePrivate === true, options.contextAvailable !== false])).digest('hex');
}
export async function listConversationContent(session: Session, userId: string, conversationId: string, options: ConversationContentOptions = {}, agentKeyId?: string, agentScopes?: string[]) {
  if (options.filter && !['all', 'context', 'stream'].includes(options.filter)) throw new ContextLaneError(400, 'Invalid content filter');
  if (options.search && (typeof options.search !== 'string' || options.search.length > 200)) throw new ContextLaneError(400, 'search must be at most 200 characters');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new ContextLaneError(400, 'limit must be between 1 and 100');
  // Even a misconfigured caller cannot expose owner-private entries to an API key.
  const includePrivate = options.includePrivate === true && !agentKeyId;
  const contextAvailable = options.contextAvailable !== false;
  const filter = contextAvailable ? options.filter || 'all' : 'stream';
  const scope = contentCursorScope(userId, conversationId, { ...options, filter, includePrivate, contextAvailable });
  let cursor: { at: string; id: string; scope: string } | undefined;
  if (options.cursor) {
    try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()); } catch { throw new ContextLaneError(400, 'Invalid content cursor'); }
    if (!cursor || cursor.scope !== scope || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 200) throw new ContextLaneError(400, 'Invalid content cursor');
  }
  const limit = options.limit ?? 50;
  return session.executeRead(async tx => {
    if (!await checkContextReadAccess(tx, userId, conversationId, agentKeyId, agentScopes)) throw new ContextLaneError(403, 'Conversation content is unavailable');
    const result = await tx.run(`
      CALL {
        MATCH (t:Thought {lane:'context', conversationId:$conversationId})
        WHERE $filter IN ['all','context']
        RETURN t, 'context' AS origin, 'conversation' AS visibility, 'context' AS provenance,
          false AS pinned, null AS pinnedBy, null AS pinnedAt, [t.id] AS aliases, coalesce(t.tags,[]) AS tags
        UNION ALL
        CALL {
          MATCH (:Conversation {id:$conversationId})<-[:PINNED_IN]-(t:Thought)
          WHERE $filter IN ['all','stream'] RETURN t
          UNION
          MATCH (source:Message {conversationId:$conversationId})<-[:FROM_MESSAGE]-(t:Thought)
          WHERE $filter IN ['all','stream'] AND (t.captureMethod IN ['inline-tag','reply-tag'] OR ($includePrivate AND t.userId=$userId)) RETURN t
          UNION
          MATCH (:User {id:$userId})-[:HAS_THOUGHT]->(t:Thought {scopeConversationId:$conversationId})
          WHERE $filter IN ['all','stream'] AND $includePrivate AND t.userId=$userId RETURN t
        }
        WITH DISTINCT t WHERE t.deletedAt IS NULL AND (t.lane IS NULL OR t.lane <> 'context')
        OPTIONAL MATCH (t)-[pin:PINNED_IN]->(:Conversation {id:$conversationId})
        OPTIONAL MATCH (t)-[:FROM_MESSAGE]->(source:Message)
        WITH t, pin, source,
          CASE WHEN pin IS NOT NULL OR (source.conversationId=$conversationId AND t.captureMethod IN ['inline-tag','reply-tag']) THEN 'conversation' ELSE 'private' END AS visibility
        // Legacy hashtag fan-out aliases merge before pagination, within identical ownership and audience.
        WITH t, pin, visibility,
          CASE WHEN source IS NOT NULL AND t.captureMethod IN ['inline-tag','reply-tag']
               THEN [source.id,t.userId,t.text,visibility] ELSE [t.id] END AS identity
        ORDER BY pin IS NOT NULL DESC, t.createdAt ASC, t.id ASC
        WITH identity, collect({node:t,pin:pin,visibility:visibility}) AS copies
        WITH head(copies) AS canonical, copies
        RETURN canonical.node AS t, 'stream' AS origin, canonical.visibility AS visibility,
          CASE WHEN canonical.pin IS NOT NULL THEN 'pinned' WHEN canonical.visibility='conversation' THEN 'message_capture' ELSE 'private_note' END AS provenance,
          canonical.pin IS NOT NULL AS pinned, canonical.pin.pinnedBy AS pinnedBy, canonical.pin.pinnedAt AS pinnedAt,
          [copy IN copies | copy.node.id] AS aliases,
          reduce(allTags=[], copy IN copies | reduce(nextTags=allTags, tag IN coalesce(copy.node.tags,[]) | CASE WHEN tag IN nextTags THEN nextTags ELSE nextTags+tag END)) AS tags
      }
      WITH t, origin, visibility, provenance, pinned, pinnedBy, pinnedAt, aliases, tags
      WHERE ($search='' OR (t.deletedAt IS NULL AND (toLower(t.text) CONTAINS toLower($search) OR any(tag IN tags WHERE toLower(tag) CONTAINS toLower($search)))))
        AND ($cursorAt IS NULL OR t.createdAt < datetime($cursorAt) OR (t.createdAt=datetime($cursorAt) AND t.id<$cursorId))
      WITH t, origin, visibility, provenance, pinned, pinnedBy, pinnedAt, aliases, tags
      ORDER BY t.createdAt DESC,t.id DESC LIMIT toInteger($limit)
      OPTIONAL MATCH (author:User {id:coalesce(t.authorId,t.userId)})
      OPTIONAL MATCH (t)-[:FROM_MESSAGE]->(source:Message)
      OPTIONAL MATCH (t)-[:REPLIES_TO]->(parent:Thought {lane:'context',conversationId:$conversationId})
      OPTIONAL MATCH (parentAuthor:User {id:parent.authorId})
      RETURN t, origin, visibility, provenance, pinned, pinnedBy, pinnedAt, aliases, tags, author.name AS authorName,
        source IS NOT NULL AS hasSourceMessage,
        CASE WHEN source.deletedAt IS NULL AND EXISTS { MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(:Conversation {id:source.conversationId}) } THEN source.id ELSE null END AS sourceMessageId,
        CASE WHEN source.deletedAt IS NULL AND EXISTS { MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(:Conversation {id:source.conversationId}) } THEN source.conversationId ELSE null END AS sourceConversationId,
        parent.id AS parentId, parent.text AS parentText, parent.deletedAt AS parentDeletedAt, parent.authorId AS parentAuthorId, parentAuthor.name AS parentAuthorName
      ORDER BY t.createdAt DESC,t.id DESC`, {
      userId, conversationId, filter, search: options.search || '', includePrivate,
      cursorAt: cursor?.at ?? null, cursorId: cursor?.id ?? '', limit: limit + 1,
    });
    const items = result.records.slice(0, limit).map(record => {
      const node = record.get('t'); const t = node.properties;
      const common = { id: t.id as string, origin: record.get('origin') as 'context'|'stream', visibility: record.get('visibility') as 'conversation'|'private', provenance: record.get('provenance') as string, createdAt: String(t.createdAt), sourceAliases: record.get('aliases') as string[] };
      if (common.origin === 'context') {
        const context = projectContextPost(node, record.get('authorName'));
        if (record.get('parentId')) context.replyToId = record.get('parentId');
        if (record.get('parentId')) context.replyTo = { id: record.get('parentId'), text: record.get('parentDeletedAt') ? '' : record.get('parentText') || '', author: { id: record.get('parentAuthorId'), name: record.get('parentAuthorName') || 'Former member' }, isDeleted: !!record.get('parentDeletedAt') };
        return { ...common, context };
      }
      return { ...common, thought: {
        id: t.id as string, text: t.text as string, kind: t.kind as string, status: t.status as string,
        createdAt: String(t.createdAt), updatedAt: String(t.updatedAt || t.createdAt), tags: record.get('tags') as string[],
        authorId: t.userId as string, authorName: record.get('authorName') || 'Former member',
        pinned: record.get('pinned') as boolean, pinnedBy: record.get('pinnedBy') as string|null, pinnedAt: asString(record.get('pinnedAt')),
        hasSourceMessage: record.get('hasSourceMessage') as boolean, sourceMessageId: record.get('sourceMessageId') as string|null,
        sourceConversationId: record.get('sourceConversationId') as string|null,
      } };
    });
    const last = items.at(-1);
    return { items, contextAvailable, ...(result.records.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id, scope })).toString('base64url') } : {}) };
  });
}
