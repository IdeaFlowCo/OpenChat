import { Server, Socket } from 'socket.io';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { validateToken, AuthUser } from '../middleware/auth.js';

interface AuthenticatedSocket extends Socket {
  user?: AuthUser;
}

// Track which sockets are in which conversations
const conversationSockets = new Map<string, Set<string>>(); // conversationId -> socketIds
const socketConversations = new Map<string, Set<string>>(); // socketId -> conversationIds

// Track user presence
const userSockets = new Map<string, Set<string>>(); // userId -> socketIds
const socketUsers = new Map<string, string>(); // socketId -> userId

export function setupChatSocket(io: Server): void {
  // Authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const user = validateToken(token);
    if (!user) {
      return next(new Error('Invalid token'));
    }

    socket.user = user;
    next();
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.user!.userId;
    console.log(`User connected: ${userId} (socket: ${socket.id})`);

    // Track user socket
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(socket.id);
    socketUsers.set(socket.id, userId);
    socketConversations.set(socket.id, new Set());

    // Update presence to online
    updateUserPresence(userId, 'available');

    // Broadcast presence to contacts
    broadcastPresenceToContacts(io, userId, 'available');

    // Join conversation room
    socket.on('conversation:join', async (conversationId: string) => {
      // Verify user is participant
      const session = getDriver().session();
      try {
        const result = await session.run(`
          MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
          RETURN c
        `, { userId, conversationId });

        if (result.records.length === 0) {
          socket.emit('error', { message: 'Not a participant of this conversation' });
          return;
        }

        socket.join(`conversation:${conversationId}`);

        if (!conversationSockets.has(conversationId)) {
          conversationSockets.set(conversationId, new Set());
        }
        conversationSockets.get(conversationId)!.add(socket.id);
        socketConversations.get(socket.id)!.add(conversationId);

        socket.emit('conversation:joined', { conversationId });
      } finally {
        await session.close();
      }
    });

    // Leave conversation room
    socket.on('conversation:leave', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      conversationSockets.get(conversationId)?.delete(socket.id);
      socketConversations.get(socket.id)?.delete(conversationId);
    });

    // Send message
    socket.on('message:send', async (data: { conversationId: string; content: string; messageType?: string }, callback) => {
      const { conversationId, content, messageType = 'text' } = data;

      if (!content || !conversationId) {
        callback?.({ error: 'conversationId and content required' });
        return;
      }

      const session = getDriver().session();
      try {
        // Verify and create message
        const check = await session.run(`
          MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
          RETURN c
        `, { userId, conversationId });

        if (check.records.length === 0) {
          callback?.({ error: 'Not a participant' });
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

        const message = convertToJS(result.records[0].get('message'));

        // Broadcast to all participants in the conversation
        io.to(`conversation:${conversationId}`).emit('message:new', message);

        callback?.({ success: true, message });
      } catch (error) {
        console.error('Error sending message:', error);
        callback?.({ error: 'Failed to send message' });
      } finally {
        await session.close();
      }
    });

    // Typing indicators
    socket.on('typing:start', (conversationId: string) => {
      socket.to(`conversation:${conversationId}`).emit('typing:start', {
        conversationId,
        userId,
      });
    });

    socket.on('typing:stop', (conversationId: string) => {
      socket.to(`conversation:${conversationId}`).emit('typing:stop', {
        conversationId,
        userId,
      });
    });

    // Update presence
    socket.on('presence:update', async (data: { status?: string; statusMessage?: string }) => {
      const { status, statusMessage } = data;
      const validStatuses = ['available', 'away', 'busy', 'invisible', 'offline'];

      if (status && !validStatuses.includes(status)) {
        socket.emit('error', { message: 'Invalid status' });
        return;
      }

      await updateUserPresence(userId, status || 'available', statusMessage);
      broadcastPresenceToContacts(io, userId, status || 'available', statusMessage);
    });

    // Heartbeat
    socket.on('heartbeat', async () => {
      await updateLastSeen(userId);
    });

    // Disconnect
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${userId} (socket: ${socket.id})`);

      // Clean up socket tracking
      userSockets.get(userId)?.delete(socket.id);
      if (userSockets.get(userId)?.size === 0) {
        userSockets.delete(userId);
        // User has no more connections - mark offline
        await updateUserPresence(userId, 'offline');
        broadcastPresenceToContacts(io, userId, 'offline');
      }

      socketUsers.delete(socket.id);

      // Clean up conversation tracking
      const convs = socketConversations.get(socket.id);
      if (convs) {
        for (const convId of convs) {
          conversationSockets.get(convId)?.delete(socket.id);
        }
      }
      socketConversations.delete(socket.id);
    });
  });
}

async function updateUserPresence(userId: string, status: string, statusMessage?: string): Promise<void> {
  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    await session.run(`
      MATCH (u:User {id: $userId})
      SET u.presenceStatus = $status,
          u.statusMessage = $statusMessage,
          u.lastSeenAt = datetime($now),
          u.presenceUpdatedAt = datetime($now)
    `, { userId, status, statusMessage: statusMessage ?? null, now });
  } finally {
    await session.close();
  }
}

async function updateLastSeen(userId: string): Promise<void> {
  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    await session.run(`
      MATCH (u:User {id: $userId})
      SET u.lastSeenAt = datetime($now)
    `, { userId, now });
  } finally {
    await session.close();
  }
}

async function broadcastPresenceToContacts(io: Server, userId: string, status: string, statusMessage?: string): Promise<void> {
  // Get all users who have conversations with this user
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)<-[:PARTICIPATES_IN]-(other:User)
      WHERE other.id <> $userId
      RETURN DISTINCT other.id AS contactId
    `, { userId });

    const contactIds = result.records.map(r => r.get('contactId'));

    // Emit to all sockets of contacts
    for (const contactId of contactIds) {
      const sockets = userSockets.get(contactId);
      if (sockets) {
        for (const socketId of sockets) {
          io.to(socketId).emit('presence:updated', {
            userId,
            status,
            statusMessage
          });
        }
      }
    }
  } finally {
    await session.close();
  }
}

function convertToJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in (value as object) && 'year' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(convertToJS);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      result[k] = convertToJS(v);
    }
    return result;
  }
  return value;
}
