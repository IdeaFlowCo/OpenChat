import { Router, Request, Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';
import neo4j from 'neo4j-driver';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { joinUserSocketsToConversation, leaveUserSocketsFromConversation } from '../websocket/chatHandler.js';

const router = Router();

// Emit conversation:created to every participant's per-user room. Clients
// (including the picortex bot) listen for this event and immediately join
// the new conversation's room so the very first message isn't dropped.
// See OpenChat-09h.
function emitConversationCreated(
  io: IOServer | undefined,
  conversation: Record<string, unknown> | null
): void {
  if (!io || !conversation) return;
  const conversationId = conversation.id as string | undefined;
  if (!conversationId) return;
  const participants = Array.isArray(conversation.participants)
    ? (conversation.participants as Array<{ user?: { id?: string } }>)
    : [];
  const seen = new Set<string>();
  for (const p of participants) {
    const pid = p?.user?.id;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    io.to(`user:${pid}`).emit('conversation:created', {
      conversationId,
      conversation
    });
  }
}

// Helper to convert Neo4j types to JS
function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in (value as object) && 'year' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      result[k] = toJS(v);
    }
    return result;
  }
  return value;
}

// GET /api/chat/conversations - List user's conversations
router.get('/conversations', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
      CALL {
        WITH c
        OPTIONAL MATCH (c)<-[:IN_CONVERSATION]-(m:Message)
        WITH m ORDER BY m.createdAt DESC
        RETURN collect(m)[0] AS lastMessage
      }
      CALL {
        WITH c
        MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
        RETURN collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt}, role: rel.role}) AS participants
      }
      RETURN c {
        .*,
        lastMessage: lastMessage { .content, .senderId, .createdAt },
        participants: participants
      } AS conversation
      ORDER BY c.lastMessageAt DESC
    `, { userId });

    const conversations = result.records.map(r => toJS(r.get('conversation')));
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/conversations - Create a conversation (1:1 or group)
router.post('/conversations', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { participantIds, title, type = 'direct' } = req.body;

  if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
    res.status(400).json({ error: 'participantIds required' });
    return;
  }

  // For direct messages, check if conversation already exists
  if (type === 'direct' && participantIds.length === 1) {
    const otherId = participantIds[0];
    const existing = await session.run(`
      MATCH (u1:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {type: 'direct'})<-[:PARTICIPATES_IN]-(u2:User {id: $otherId})
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      WITH c, collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt}, role: rel.role}) AS participants
      RETURN c {
        .*,
        participants: participants
      } AS conversation
    `, { userId, otherId });

    if (existing.records.length > 0) {
      const conv = toJS(existing.records[0].get('conversation'));
      await session.close();
      res.json(conv);
      return;
    }
  }

  const conversationId = nanoid();
  const now = new Date().toISOString();
  const allParticipants = [userId, ...participantIds.filter((id: string) => id !== userId)];

  try {
    const result = await session.run(`
      CREATE (c:Conversation {
        id: $id,
        title: $title,
        type: $type,
        createdAt: datetime($now),
        updatedAt: datetime($now),
        lastMessageAt: datetime($now)
      })
      WITH c
      UNWIND $participants AS pid
      MATCH (u:User {id: pid})
      CREATE (u)-[rel:PARTICIPATES_IN {
        joinedAt: datetime($now),
        role: CASE WHEN pid = $userId THEN 'owner' ELSE 'member' END
      }]->(c)
      WITH c, collect({user: u {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt}, role: rel.role}) AS participants
      RETURN c { .*, participants: participants } AS conversation
    `, {
      id: conversationId,
      title: title || null,
      type,
      now,
      participants: allParticipants,
      userId
    });

    const conversation = toJS(result.records[0].get('conversation')) as
      | Record<string, unknown>
      | null;

    // Notify all participants (including creator, for consistency) via their
    // per-user socket rooms so their clients can auto-join the new room.
    const io = req.app.get('io') as IOServer | undefined;
    emitConversationCreated(io, conversation);

    res.status(201).json(conversation);
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  } finally {
    await session.close();
  }
});

// Helper: load full conversation with participants (used by mutating endpoints
// that need to broadcast a fresh shape to clients). Returns null if the
// conversation has no participants left (i.e. fully drained group).
async function loadConversation(
  session: ReturnType<ReturnType<typeof getDriver>['session']>,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  const result = await session.run(`
    MATCH (c:Conversation {id: $conversationId})
    OPTIONAL MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
    WITH c, collect(
      CASE WHEN participant IS NULL THEN NULL
      ELSE {user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt}, role: rel.role}
      END
    ) AS rawParticipants
    WITH c, [p IN rawParticipants WHERE p IS NOT NULL] AS participants
    RETURN c {
      .*,
      participants: participants
    } AS conversation
  `, { conversationId });
  if (result.records.length === 0) return null;
  return toJS(result.records[0].get('conversation')) as Record<string, unknown>;
}

// Emit conversation:updated to every current participant's user-room.
function emitConversationUpdated(
  io: IOServer | undefined,
  conversation: Record<string, unknown> | null
): void {
  if (!io || !conversation) return;
  const conversationId = conversation.id as string | undefined;
  if (!conversationId) return;
  const participants = Array.isArray(conversation.participants)
    ? (conversation.participants as Array<{ user?: { id?: string } }>)
    : [];
  const seen = new Set<string>();
  for (const p of participants) {
    const pid = p?.user?.id;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    io.to(`user:${pid}`).emit('conversation:updated', { conversationId, conversation });
  }
  // Also emit to anyone currently in the conversation room (in case they're
  // in a non-participant viewer state — edge case but cheap)
  io.to(`conversation:${conversationId}`).emit('conversation:updated', { conversationId, conversation });
}

// PATCH /api/chat/conversations/:id - Update title (owner-only for groups)
router.patch('/conversations/:id', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const { title } = req.body as { title?: string };

  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  try {
    // Verify owner
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $id})
      RETURN c, rel.role AS role
    `, { userId, id });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const role = check.records[0].get('role');
    if (role !== 'owner') {
      res.status(403).json({ error: 'Only the group owner can rename' });
      return;
    }

    await session.run(`
      MATCH (c:Conversation {id: $id})
      SET c.title = $title, c.updatedAt = datetime($now)
    `, { id, title: title.trim(), now: new Date().toISOString() });

    const conversation = await loadConversation(session, id);
    const io = req.app.get('io') as IOServer | undefined;
    emitConversationUpdated(io, conversation);
    res.json(conversation);
  } catch (error) {
    console.error('Error updating conversation:', error);
    res.status(500).json({ error: 'Failed to update conversation' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/conversations/:id/participants - Add a member (owner-only, group only)
router.post('/conversations/:id/participants', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const { userId: targetId } = req.body as { userId?: string };

  if (!targetId || typeof targetId !== 'string') {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  try {
    // Verify caller is owner of a group
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $id})
      RETURN c.type AS type, rel.role AS role
    `, { userId, id });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const role = check.records[0].get('role');
    const type = check.records[0].get('type');
    if (type !== 'group') {
      res.status(400).json({ error: 'Cannot add participants to a direct conversation' });
      return;
    }
    if (role !== 'owner') {
      res.status(403).json({ error: 'Only the group owner can add members' });
      return;
    }

    // Verify target user exists
    const userCheck = await session.run(`MATCH (u:User {id: $targetId}) RETURN u`, { targetId });
    if (userCheck.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Idempotent add: MERGE relationship; preserve role/joinedAt if already present
    const now = new Date().toISOString();
    await session.run(`
      MATCH (c:Conversation {id: $id})
      MATCH (u:User {id: $targetId})
      MERGE (u)-[rel:PARTICIPATES_IN]->(c)
        ON CREATE SET rel.joinedAt = datetime($now), rel.role = 'member'
      SET c.updatedAt = datetime($now)
    `, { id, targetId, now });

    const conversation = await loadConversation(session, id);
    const io = req.app.get('io') as IOServer | undefined;
    if (io && conversation) {
      // Auto-join the new member's live sockets to the conversation room so
      // they start receiving message:new immediately, without needing to
      // click into the conversation first.
      joinUserSocketsToConversation(io, targetId, id);

      // Notify all current participants (incl. newly-added) so their clients
      // refresh.
      const participants = (conversation.participants as Array<{ user?: { id?: string } }>) || [];
      const seen = new Set<string>();
      for (const p of participants) {
        const pid = p?.user?.id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        io.to(`user:${pid}`).emit('participant:added', {
          conversationId: id,
          conversation,
          userId: targetId,
        });
      }
    }

    res.status(201).json(conversation);
  } catch (error) {
    console.error('Error adding participant:', error);
    res.status(500).json({ error: 'Failed to add participant' });
  } finally {
    await session.close();
  }
});

// DELETE /api/chat/conversations/:id/participants/:userId - Remove member or leave
router.delete('/conversations/:id/participants/:userId', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const callerId = req.user!.userId;
  const id = req.params.id as string;
  const targetId = req.params.userId as string;

  try {
    // Caller must be participant
    const callerCheck = await session.run(`
      MATCH (u:User {id: $callerId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $id})
      RETURN c.type AS type, rel.role AS role
    `, { callerId, id });

    if (callerCheck.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const type = callerCheck.records[0].get('type');
    const callerRole = callerCheck.records[0].get('role');
    if (type !== 'group') {
      res.status(400).json({ error: 'Cannot remove participants from a direct conversation' });
      return;
    }

    const isSelf = callerId === targetId;
    if (!isSelf && callerRole !== 'owner') {
      res.status(403).json({ error: 'Only the group owner can remove other members' });
      return;
    }

    // Owner leaving with other members still present: block. Force a transfer
    // (or removal of others first) — simpler to keep the invariant for now.
    if (isSelf && callerRole === 'owner') {
      const countResult = await session.run(`
        MATCH (:User)-[:PARTICIPATES_IN]->(c:Conversation {id: $id})
        RETURN count(*) AS n
      `, { id });
      const n = countResult.records[0]?.get('n')?.toNumber?.() ?? 0;
      if (n > 1) {
        res.status(400).json({ error: 'Owner cannot leave a group with other members. Remove members first.' });
        return;
      }
    }

    // Capture participant ids BEFORE removal so we can notify the removed user too
    const before = await loadConversation(session, id);
    const beforeParticipants = (before?.participants as Array<{ user?: { id?: string } }>) || [];

    await session.run(`
      MATCH (u:User {id: $targetId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $id})
      DELETE rel
      SET c.updatedAt = datetime($now)
    `, { id, targetId, now: new Date().toISOString() });

    const after = await loadConversation(session, id);

    const io = req.app.get('io') as IOServer | undefined;
    if (io) {
      // Yank the removed user's sockets out of the conversation room first,
      // so they don't receive the very participant:removed event for "you".
      // (We still emit to their per-user room below.)
      leaveUserSocketsFromConversation(io, targetId, id);

      // Notify everyone who was a participant (this includes the removed
      // user, via their per-user room).
      const seen = new Set<string>();
      for (const p of beforeParticipants) {
        const pid = p?.user?.id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        io.to(`user:${pid}`).emit('participant:removed', {
          conversationId: id,
          userId: targetId,
          conversation: after,
        });
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error removing participant:', error);
    res.status(500).json({ error: 'Failed to remove participant' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/conversations/:id - Get conversation with participants
router.get('/conversations/:id', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id } = req.params;

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $id})
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      RETURN c, collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt}, role: rel.role}) AS participants
    `, { userId, id });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const conv = toJS(result.records[0].get('c').properties) as Record<string, unknown>;
    const participants = toJS(result.records[0].get('participants'));
    res.json({ ...conv, participants });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/conversations/:id/messages - Get messages (paginated)
router.get('/conversations/:id/messages', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const before = req.query.before as string | undefined;

  try {
    // Verify user is participant
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $id})
      RETURN c
    `, { userId, id });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const query = before
      ? `
        MATCH (m:Message {conversationId: $id})
        WHERE m.createdAt < datetime($before) AND m.deletedAt IS NULL
        MATCH (sender:User {id: m.senderId})
        RETURN m { .*, sender: sender { .id, .name, .email } } AS message
        ORDER BY m.createdAt DESC
        LIMIT $limit
      `
      : `
        MATCH (m:Message {conversationId: $id})
        WHERE m.deletedAt IS NULL
        MATCH (sender:User {id: m.senderId})
        RETURN m { .*, sender: sender { .id, .name, .email } } AS message
        ORDER BY m.createdAt DESC
        LIMIT $limit
      `;

    const result = await session.run(query, { id, limit: neo4j.int(limit), before });
    const messages = result.records.map(r => toJS(r.get('message'))).reverse();
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/conversations/:id/messages - Send a message
router.post('/conversations/:id/messages', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id: conversationId } = req.params;
  const { content, messageType = 'text' } = req.body;

  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  try {
    // Verify user is participant
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      RETURN c
    `, { userId, conversationId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const messageId = nanoid();
    const now = new Date().toISOString();

    const result = await session.run(`
      MATCH (c:Conversation {id: $conversationId})
      MATCH (sender:User {id: $senderId})
      CREATE (m:Message {
        id: $id,
        content: $content,
        senderId: $senderId,
        conversationId: $conversationId,
        messageType: $messageType,
        createdAt: datetime($now)
      })
      CREATE (m)-[:IN_CONVERSATION]->(c)
      CREATE (sender)-[:SENT]->(m)
      SET c.updatedAt = datetime($now),
          c.lastMessageAt = datetime($now),
          c.lastMessagePreview = left($content, 100)
      RETURN m { .*, sender: sender { .id, .name, .email } } AS message
    `, {
      id: messageId,
      content,
      senderId: userId,
      conversationId,
      messageType,
      now
    });

    const message = toJS(result.records[0].get('message'));
    res.status(201).json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/contacts - Get all users (for starting conversations)
// Supports ?q=search to filter by name or email (case-insensitive)
router.get('/contacts', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const searchQuery = req.query.q as string | undefined;

  try {
    const query = searchQuery
      ? `
        MATCH (u:User)
        WHERE u.id <> $userId
          AND (toLower(u.name) CONTAINS toLower($search) OR toLower(u.email) CONTAINS toLower($search))
        RETURN u { .id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt } AS user
        ORDER BY u.name
      `
      : `
        MATCH (u:User)
        WHERE u.id <> $userId
        RETURN u { .id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt } AS user
        ORDER BY u.name
      `;

    const result = await session.run(query, { userId, search: searchQuery || '' });
    const contacts = result.records.map(r => toJS(r.get('user')));
    res.json(contacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/users/by-email/:email - Look up user by exact email
router.get('/users/by-email/:email', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const { email } = req.params;

  try {
    const result = await session.run(`
      MATCH (u:User {email: $email})
      RETURN u { .id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt } AS user
    `, { email });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = toJS(result.records[0].get('user'));
    res.json(user);
  } catch (error) {
    console.error('Error fetching user by email:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  } finally {
    await session.close();
  }
});

// PUT /api/chat/presence - Update own presence
router.put('/presence', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { presenceStatus, statusMessage } = req.body;

  const validStatuses = ['available', 'away', 'busy', 'invisible', 'offline'];
  if (presenceStatus && !validStatuses.includes(presenceStatus)) {
    res.status(400).json({ error: 'Invalid presence status' });
    return;
  }

  try {
    const now = new Date().toISOString();
    const result = await session.run(`
      MATCH (u:User {id: $userId})
      SET u.presenceStatus = coalesce($presenceStatus, u.presenceStatus),
          u.statusMessage = $statusMessage,
          u.lastSeenAt = datetime($now),
          u.presenceUpdatedAt = datetime($now)
      RETURN u { .id, .presenceStatus, .statusMessage, .lastSeenAt } AS user
    `, { userId, presenceStatus, statusMessage: statusMessage ?? null, now });

    const user = toJS(result.records[0].get('user'));
    res.json(user);
  } catch (error) {
    console.error('Error updating presence:', error);
    res.status(500).json({ error: 'Failed to update presence' });
  } finally {
    await session.close();
  }
});

export default router;
