import { Session } from 'neo4j-driver';
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

export async function createContextPost(
  session: Session,
  userId: string,
  conversationId: string,
  input: ContextPostInput,
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<ContextPostProjection> {
  const { text, clientRequestId, replyToId } = input;
  const kind = input.kind || 'note';

  if (!text || text.trim() === '') {
    throw new ContextLaneError(400, 'Text is required');
  }

  return await session.executeWrite(async (tx) => {
    // 1. Lock and check access
    await acquireContextAclLocks(tx, { userIds: [userId], conversationId });
    const hasAccess = await checkContextWriteAccess(tx, userId, conversationId, agentKeyId, agentScopes);
    if (!hasAccess) {
      throw new ContextLaneError(403, 'Not authorized to write to this context lane');
    }

    // 2. Check for idempotency (same clientRequestId)
    const idempotencyCheck = await tx.run(
      `MATCH (t:Thought {clientRequestId: $clientRequestId, authorId: $userId, conversationId: $conversationId, lane: 'context'})
       RETURN t`,
      { clientRequestId, userId, conversationId }
    );
    if (idempotencyCheck.records.length > 0) {
      return projectContextPost(idempotencyCheck.records[0].get('t'));
    }

    // Check quotas
    const jsNow = new Date();
    const currentMinute = Math.floor(jsNow.getTime() / 60000);
    const currentDate = jsNow.toISOString().split('T')[0];

    const quotaCheck = await tx.run(
      `MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
       RETURN u.contextMutationsMinute AS cmMinute, u.contextMutationsCount AS cmCount,
              rel.contextPubsDate AS cpDate, rel.contextPubsCount AS cpCount,
              size([(u)-[:HAS_THOUGHT]->(t:Thought) WHERE t.lane = 'context' AND t.conversationId = $conversationId AND t.kind IN ['ask', 'offer'] AND (t.status IS NULL OR t.status = 'open') | t]) AS activeCount
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
         SET u.contextMutationsMinute = $currentMinute,
             u.contextMutationsCount = CASE WHEN u.contextMutationsMinute = $currentMinute THEN u.contextMutationsCount + 1 ELSE 1 END,
             rel.contextPubsDate = $currentDate,
             rel.contextPubsCount = CASE WHEN rel.contextPubsDate = $currentDate THEN rel.contextPubsCount + 1 ELSE 1 END
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
        clientRequestId: $clientRequestId
      })
      CREATE (u)-[:HAS_THOUGHT]->(t)
      ${replyClause}
      RETURN t
    `, { userId, conversationId, id, text, kind, now, clientRequestId, replyToId });

    if (result.records.length === 0) {
      throw new ContextLaneError(500, 'Failed to create context post');
    }

    const t = result.records[0].get('t');
    const projection = projectContextPost(t);
    if (replyToId) {
      projection.replyToId = replyToId;
    }
    return projection;
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
  return await session.executeWrite(async (tx) => {
    await acquireContextAclLocks(tx, { userIds: [userId], conversationId });
    const hasAccess = await checkContextWriteAccess(tx, userId, conversationId, agentKeyId, agentScopes);
    if (!hasAccess) {
      throw new ContextLaneError(403, 'Not authorized to write to this context lane');
    }

    const check = await tx.run(
      `MATCH (t:Thought {id: $postId, conversationId: $conversationId, lane: 'context'})
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
       OPTIONAL MATCH (t)-[:REPLIES_TO]->(parent:Thought)
       RETURN t, parent.id AS replyToId`,
      { postId, conversationId, text, now }
    );

    const t = result.records[0].get('t');
    const replyToId = result.records[0].get('replyToId');
    const projection = projectContextPost(t);
    if (replyToId) {
      projection.replyToId = replyToId;
    }
    return projection;
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
    await acquireContextAclLocks(tx, { userIds: [actorId], conversationId });
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
       DETACH DELETE t`,
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

    if (options.kind) {
      filterClause += ` AND t.kind = $kind`;
      params.kind = options.kind;
    }

    if (options.search) {
      filterClause += ` AND t.text CONTAINS $search`;
      params.search = options.search;
    }

    if (options.cursor) {
      filterClause += ` AND t.createdAt < datetime($cursor)`;
      params.cursor = options.cursor;
    }

    const limit = Math.min(options.limit || 50, 100);
    params.limit = limit;

    const result = await tx.run(
      `MATCH (t:Thought)
       WHERE ${filterClause}
       OPTIONAL MATCH (t)-[:REPLIES_TO]->(parent:Thought)
       RETURN t, parent.id AS replyToId
       ORDER BY t.createdAt DESC, t.id DESC
       LIMIT toInteger($limit)`,
      params
    );

    const posts = result.records.map(r => {
      const p = projectContextPost(r.get('t'));
      const replyToId = r.get('replyToId');
      if (replyToId) p.replyToId = replyToId;
      return p;
    });

    let nextCursor: string | undefined;
    if (posts.length === limit && posts.length > 0) {
      nextCursor = posts[posts.length - 1].createdAt;
    }

    return { posts, nextCursor };
  });
}

function projectContextPost(node: any): ContextPostProjection {
  return {
    id: node.properties.id,
    conversationId: node.properties.conversationId,
    authorId: node.properties.authorId,
    text: node.properties.text,
    kind: node.properties.kind || 'note',
    lane: 'context',
    revision: node.properties.revision ? (node.properties.revision.toNumber ? node.properties.revision.toNumber() : node.properties.revision) : 1,
    createdAt: node.properties.createdAt.toString(),
    updatedAt: node.properties.updatedAt.toString(),
    clientRequestId: node.properties.clientRequestId,
  };
}