import { Session } from 'neo4j-driver';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { acquireContextAclLocks, checkContextReadAccess, checkContextWriteAccess } from './contextAccess.js';

export interface ContextPostInput {
  text: string;
  kind?: string; // 'note', 'ask', 'offer'
  clientRequestId: string;
  replyToId?: string;
}

export interface ContextPostProjection {
  id: string;
  conversationId: string;
  authorId: string;
  author: { id: string; name: string };
  agent?: { id: string; name: string };
  replyTo?: { id: string; text: string; author: { id: string; name: string }; isDeleted: boolean };
  text: string;
  kind: string;
  lane: 'context';
  revision: number;
  createdAt: string;
  updatedAt: string;
  replyToId?: string;
  clientRequestId: string;
  isDeleted?: boolean;
}

export class ContextLaneError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'ContextLaneError';
  }
}

const MAX_TEXT_LENGTH = 20000;
function validateText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    throw new ContextLaneError(400, `text must contain 1–${MAX_TEXT_LENGTH} characters`);
  }
}
const projectionJoins = `
  OPTIONAL MATCH (author:User {id: t.authorId})
  OPTIONAL MATCH (t)-[:REPLIES_TO]->(parent:Thought)
  OPTIONAL MATCH (parentAuthor:User {id: parent.authorId})`;
const projectionReturn = `t, author.name AS authorName, parent.id AS replyToId,
  parent.text AS replyText, parent.deletedAt AS replyDeletedAt,
  parent.authorId AS replyAuthorId, parentAuthor.name AS replyAuthorName`;
function projectRecord(record: any): ContextPostProjection {
  const post = projectContextPost(record.get('t'), record.get('authorName'));
  if (record.get('replyToId')) {
    post.replyToId = record.get('replyToId');
    post.replyTo = { id: post.replyToId!, text: record.get('replyDeletedAt') ? '' : record.get('replyText') || '',
      author: { id: record.get('replyAuthorId'), name: record.get('replyAuthorName') || 'Former member' },
      isDeleted: !!record.get('replyDeletedAt') };
  }
  return post;
}

export async function createContextPost(
  session: Session,
  userId: string,
  conversationId: string,
  input: ContextPostInput,
  agentKeyId?: string,
  agentScopes?: string[],
  authenticatedAgent?: { id: string; name: string }
): Promise<ContextPostProjection> {
  const { text, clientRequestId, replyToId } = input;
  const kind = input.kind || 'note';

  validateText(text);
  if (!['note', 'ask', 'offer'].includes(kind) || typeof clientRequestId !== 'string' || !clientRequestId.trim() || clientRequestId.length > 200 ||
      (replyToId !== undefined && (typeof replyToId !== 'string' || !replyToId.trim()))) {
    throw new ContextLaneError(400, 'Invalid kind, clientRequestId, or replyToId');
  }
  const requestHash = createHash('sha256').update(JSON.stringify([text, kind, replyToId || null, agentKeyId || authenticatedAgent?.id || null])).digest('hex');

  return await session.executeWrite(async (tx) => {
    // 1. Lock and check access
    await acquireContextAclLocks(tx, { userIds: [userId], conversationId, agentKeyId });
    const hasAccess = await checkContextWriteAccess(tx, userId, conversationId, agentKeyId, agentScopes);
    if (!hasAccess) {
      throw new ContextLaneError(403, 'Not authorized to write to this context lane');
    }

    // 2. Check for idempotency (same clientRequestId)
    const idempotencyCheck = await tx.run(
      `MATCH (t:Thought {clientRequestId: $clientRequestId, authorId: $userId, conversationId: $conversationId, lane: 'context'})
       ${projectionJoins}
       RETURN ${projectionReturn}`,
      { clientRequestId, userId, conversationId }
    );
    if (idempotencyCheck.records.length > 0) {
      const record = idempotencyCheck.records[0];
      const existing = record.get('t').properties;
      // Legacy posts predate the digest; compare the available original fields.
      if (existing.requestHash ? existing.requestHash !== requestHash :
          existing.text !== text || (existing.kind || 'note') !== kind || (record.get('replyToId') || null) !== (replyToId || null)) {
        throw new ContextLaneError(409, 'clientRequestId was already used for a different post');
      }
      return projectRecord(record);
    }

    if (replyToId) {
      const parent = await tx.run(`MATCH (parent:Thought {id:$replyToId, conversationId:$conversationId, lane:'context'})
        WHERE parent.deletedAt IS NULL RETURN parent.id AS id`, { replyToId, conversationId });
      if (!parent.records.length) throw new ContextLaneError(404, 'Reply target not found');
    }

    // Check quotas
    const jsNow = new Date();
    const currentMinute = Math.floor(jsNow.getTime() / 60000);
    const currentDate = jsNow.toISOString().split('T')[0];

    const quotaCheck = await tx.run(
      `MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
       RETURN u.contextMutationsMinute AS cmMinute, u.contextMutationsCount AS cmCount,
              rel.contextPubsDate AS cpDate, rel.contextPubsCount AS cpCount,
              size([(u)-[:HAS_THOUGHT]->(t:Thought) WHERE t.lane = 'context' AND t.conversationId = $conversationId AND t.deletedAt IS NULL AND t.kind IN ['ask', 'offer'] AND (t.status IS NULL OR t.status = 'open') | t]) AS activeCount
      `,
      { userId, conversationId }
    );

    if (quotaCheck.records.length > 0) {
      const rec = quotaCheck.records[0];
      const cmMinute = rec.get('cmMinute')?.toNumber?.() || rec.get('cmMinute');
      const cmCount = rec.get('cmCount')?.toNumber?.() || rec.get('cmCount') || 0;
      if (cmMinute === currentMinute && cmCount >= 20) {
        throw new ContextLaneError(429, 'Rate limit exceeded: 20 publication mutations/minute');
      }

      const cpDate = rec.get('cpDate');
      const cpCount = rec.get('cpCount')?.toNumber?.() || rec.get('cpCount') || 0;
      if (cpDate === currentDate && cpCount >= 100) {
        throw new ContextLaneError(429, 'Rate limit exceeded: 100 publications/day/conversation');
      }

      const activeCount = rec.get('activeCount')?.toNumber?.() || rec.get('activeCount') || 0;
      if ((kind === 'ask' || kind === 'offer') && activeCount >= 50) {
        throw new ContextLaneError(429, 'Rate limit exceeded: 50 open typed publications/user/conversation');
      }

      // Update counters
      await tx.run(
        `MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
         SET u.contextMutationsCount = CASE WHEN u.contextMutationsMinute = $currentMinute THEN coalesce(u.contextMutationsCount, 0) + 1 ELSE 1 END,
             u.contextMutationsMinute = $currentMinute,
             rel.contextPubsCount = CASE WHEN rel.contextPubsDate = $currentDate THEN coalesce(rel.contextPubsCount, 0) + 1 ELSE 1 END,
             rel.contextPubsDate = $currentDate
        `,
        { userId, conversationId, currentMinute, currentDate }
      );
    }

    // 3. Create post
    const id = nanoid();
    const now = new Date().toISOString();
    
    // Determine reply
    let replyClause = '';
    if (replyToId) {
      replyClause = `
        WITH u, t, c
        MATCH (parent:Thought {id: $replyToId, conversationId: $conversationId, lane: 'context'})
        CREATE (t)-[:REPLIES_TO]->(parent)
      `;
    }

    const result = await tx.run(`
      MATCH (u:User {id: $userId}), (c:Conversation {id: $conversationId})
      OPTIONAL MATCH (key:AgentKey {id: $agentKeyId})
      CREATE (t:Thought {
        id: $id,
        authorId: $userId,
        conversationId: $conversationId,
        text: $text,
        kind: $kind,
        lane: 'context',
        revision: 1,
        createdAt: datetime($now),
        updatedAt: datetime($now),
        clientRequestId: $clientRequestId,
        requestHash: $requestHash,
        agentKeyId: $agentKeyId,
        connectorAgentId: $connectorAgentId,
        agentName: CASE WHEN $agentKeyId IS NULL THEN $connectorAgentName ELSE coalesce(key.name, 'Agent') END
      })
      CREATE (u)-[:HAS_THOUGHT]->(t)
      ${replyClause}
      WITH t
      ${projectionJoins}
      RETURN ${projectionReturn}
    `, { userId, conversationId, id, text, kind, now, clientRequestId, replyToId: replyToId || null, agentKeyId: agentKeyId || null, connectorAgentId: authenticatedAgent?.id || null, connectorAgentName: authenticatedAgent?.name || null, requestHash });

    if (result.records.length === 0) {
      throw new ContextLaneError(500, 'Failed to create context post');
    }

    return projectRecord(result.records[0]);
  });
}

export async function updateContextPost(
  session: Session,
  userId: string,
  conversationId: string,
  postId: string,
  text: string,
  expectedRevision: number,
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<ContextPostProjection> {
  validateText(text);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ContextLaneError(400, 'expectedRevision must be a positive integer');
  return await session.executeWrite(async (tx) => {
    await acquireContextAclLocks(tx, { userIds: [userId], conversationId, agentKeyId });
    const hasAccess = await checkContextWriteAccess(tx, userId, conversationId, agentKeyId, agentScopes);
    if (!hasAccess) {
      throw new ContextLaneError(403, 'Not authorized to write to this context lane');
    }

    const check = await tx.run(
      `MATCH (t:Thought {id: $postId, conversationId: $conversationId, lane: 'context'})
       WHERE t.deletedAt IS NULL
       RETURN t.authorId AS authorId, t.revision AS revision`,
      { postId, conversationId }
    );

    if (check.records.length === 0) {
      throw new ContextLaneError(404, 'Post not found');
    }

    const authorId = check.records[0].get('authorId');
    const currentRevision = check.records[0].get('revision').toNumber ? check.records[0].get('revision').toNumber() : check.records[0].get('revision');

    if (authorId !== userId) {
      throw new ContextLaneError(403, 'Can only edit your own posts');
    }

    if (currentRevision !== expectedRevision) {
      throw new ContextLaneError(409, 'Revision mismatch');
    }

    const now = new Date().toISOString();
    const result = await tx.run(
      `MATCH (t:Thought {id: $postId, conversationId: $conversationId, lane: 'context'})
       SET t.text = $text, t.revision = t.revision + 1, t.updatedAt = datetime($now)
       WITH t
       ${projectionJoins}
       RETURN ${projectionReturn}`,
      { postId, conversationId, text, now }
    );

    return projectRecord(result.records[0]);
  });
}

export async function deleteContextPost(
  session: Session,
  actorId: string,
  conversationId: string,
  postId: string,
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<void> {
  return await session.executeWrite(async (tx) => {
    await acquireContextAclLocks(tx, { userIds: [actorId], conversationId, agentKeyId });
    const hasAccess = await checkContextWriteAccess(tx, actorId, conversationId, agentKeyId, agentScopes);
    if (!hasAccess) {
      throw new ContextLaneError(403, 'Not authorized');
    }

    const info = await tx.run(
      `MATCH (t:Thought {id: $postId, conversationId: $conversationId, lane: 'context'})
       MATCH (u:User {id: $actorId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
       RETURN t.authorId AS authorId, rel.role AS role, c.type AS convType`,
      { postId, conversationId, actorId }
    );

    if (info.records.length === 0) {
      throw new ContextLaneError(404, 'Post not found or not in conversation');
    }

    const authorId = info.records[0].get('authorId');
    const role = info.records[0].get('role');
    const convType = info.records[0].get('convType');

    if (authorId !== actorId) {
      if (convType !== 'group' || role !== 'owner') {
        throw new ContextLaneError(403, 'Only the author or group owner can delete this post');
      }
    }

    await tx.run(
      `MATCH (t:Thought {id: $postId, conversationId: $conversationId, lane: 'context'})
       SET t.text = '', t.deletedAt = coalesce(t.deletedAt, datetime()),
           t.updatedAt = datetime(), t.revision = t.revision + 1`,
      { postId, conversationId }
    );
  });
}

export async function listContextPosts(
  session: Session,
  userId: string,
  conversationId: string,
  options: {
    cursor?: string;
    limit?: number;
    kind?: string;
    search?: string;
  } = {},
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<{ posts: ContextPostProjection[], nextCursor?: string }> {
  return await session.executeRead(async (tx) => {
    const hasAccess = await checkContextReadAccess(tx, userId, conversationId, agentKeyId, agentScopes);
    if (!hasAccess) {
      throw new ContextLaneError(403, 'Not authorized to read this context lane');
    }

    let filterClause = `t.lane = 'context' AND t.conversationId = $conversationId`;
    const params: any = { conversationId };

    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new ContextLaneError(400, 'limit must be a positive integer');
    if (options.kind && !['note', 'ask', 'offer'].includes(options.kind)) throw new ContextLaneError(400, 'Invalid kind');
    if (options.search && (typeof options.search !== 'string' || options.search.length > 200)) throw new ContextLaneError(400, 'search must be at most 200 characters');

    if (options.kind) {
      filterClause += ` AND t.kind = $kind`;
      params.kind = options.kind;
    }

    if (options.search) {
      filterClause += ` AND t.deletedAt IS NULL AND toLower(t.text) CONTAINS toLower($search)`;
      params.search = options.search;
    }

    if (options.cursor) {
      // Accept old timestamp cursors while new cursors include the ID tie-breaker.
      let cursor: { createdAt: string; id?: string };
      try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()); }
      catch { cursor = { createdAt: options.cursor }; }
      if (!cursor || typeof cursor.createdAt !== 'string' || !Number.isFinite(Date.parse(cursor.createdAt)) || (cursor.id !== undefined && typeof cursor.id !== 'string')) {
        throw new ContextLaneError(400, 'Invalid cursor');
      }
      filterClause += cursor.id ? ` AND (t.createdAt < datetime($cursor) OR (t.createdAt = datetime($cursor) AND t.id < $cursorId))` : ` AND t.createdAt < datetime($cursor)`;
      params.cursor = cursor.createdAt;
      params.cursorId = cursor.id || null;
    }

    const limit = Math.min(options.limit || 50, 100);
    params.limit = limit + 1;

    const result = await tx.run(
      `MATCH (t:Thought)
       WHERE ${filterClause}
       ${projectionJoins}
       RETURN ${projectionReturn}
       ORDER BY t.createdAt DESC, t.id DESC
       LIMIT toInteger($limit)`,
      params
    );

    const posts = result.records.slice(0, limit).map(projectRecord);
    const last = posts[posts.length - 1];
    const nextCursor = result.records.length > limit && last ?
      Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : undefined;

    return { posts, nextCursor };
  });
}

function projectContextPost(node: any, authorName?: string): ContextPostProjection {
  return {
    id: node.properties.id,
    conversationId: node.properties.conversationId,
    authorId: node.properties.authorId,
    author: { id: node.properties.authorId, name: authorName || 'Former member' },
    ...((node.properties.agentKeyId || node.properties.connectorAgentId) ? { agent: { id: node.properties.agentKeyId || node.properties.connectorAgentId, name: node.properties.agentName || 'Agent' } } : {}),
    isDeleted: !!node.properties.deletedAt,
    text: node.properties.deletedAt ? '' : node.properties.text,
    kind: node.properties.kind || 'note',
    lane: 'context',
    revision: node.properties.revision ? (node.properties.revision.toNumber ? node.properties.revision.toNumber() : node.properties.revision) : 1,
    createdAt: node.properties.createdAt.toString(),
    updatedAt: node.properties.updatedAt.toString(),
    clientRequestId: node.properties.clientRequestId,
  };
}
/** Report is deliberately stored locally; shared Context bodies never fan out to webhooks. */
export async function reportContextPost(
  session: Session, userId: string, conversationId: string, postId: string,
  reason: string, freeform?: string, agentKeyId?: string, agentScopes?: string[]
): Promise<{ id: string }> {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 100 ||
      (freeform !== undefined && (typeof freeform !== 'string' || freeform.length > 2000))) {
    throw new ContextLaneError(400, 'reason is required (up to 100 characters); details must be at most 2000 characters');
  }
  return session.executeWrite(async tx => {
    await acquireContextAclLocks(tx, { userIds: [userId], conversationId, agentKeyId });
    if (!await checkContextWriteAccess(tx, userId, conversationId, agentKeyId, agentScopes)) throw new ContextLaneError(403, 'Not authorized');
    const result = await tx.run(`MATCH (t:Thought {id:$postId, conversationId:$conversationId, lane:'context'})
      WHERE t.deletedAt IS NULL
      MERGE (r:Report {reporterId:$userId, targetType:'context', targetId:$postId})
      ON CREATE SET r.id=$id, r.createdAt=datetime(), r.status='open', r.reason=$reason, r.freeform=$freeform
      RETURN r.id AS id`, { postId, conversationId, userId, id: nanoid(), reason: reason.trim(), freeform: freeform || null });
    if (!result.records.length) throw new ContextLaneError(404, 'Post not found');
    return { id: result.records[0].get('id') };
  });
}
