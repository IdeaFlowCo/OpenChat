import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import neo4j from 'neo4j-driver';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

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

    const conversation = toJS(result.records[0].get('conversation'));
    res.status(201).json(conversation);
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
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
