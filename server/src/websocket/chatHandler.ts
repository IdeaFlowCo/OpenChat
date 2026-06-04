import { Server, Socket } from 'socket.io';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { validateToken, AuthUser } from '../middleware/auth.js';
import { sendPushToUser } from '../services/push.js';
import { processLinkPreviews } from '../services/linkPreview.js';

interface AuthenticatedSocket extends Socket {
  user?: AuthUser;
}

// Track which sockets are in which conversations
const conversationSockets = new Map<string, Set<string>>(); // conversationId -> socketIds
const socketConversations = new Map<string, Set<string>>(); // socketId -> conversationIds

// Track user presence
const userSockets = new Map<string, Set<string>>(); // userId -> socketIds
const socketUsers = new Map<string, string>(); // socketId -> userId

// Export the user-presence map so HTTP route handlers can check online status
// for "delivered" inference without a DB round-trip.
export function isUserOnline(userId: string): boolean {
  return (userSockets.get(userId)?.size ?? 0) > 0;
}

// Force-join a user's live sockets to a conversation room. Used when a
// member is added to a group: their existing connection should immediately
// start receiving message:new without waiting for them to click the conv.
export function joinUserSocketsToConversation(io: Server, userId: string, conversationId: string): void {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  for (const socketId of sockets) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue;
    s.join(`conversation:${conversationId}`);
    if (!conversationSockets.has(conversationId)) {
      conversationSockets.set(conversationId, new Set());
    }
    conversationSockets.get(conversationId)!.add(socketId);
    if (!socketConversations.has(socketId)) {
      socketConversations.set(socketId, new Set());
    }
    socketConversations.get(socketId)!.add(conversationId);
  }
}

// Force-leave a user's live sockets from a conversation room. Used when a
// member is removed/leaves so they don't keep getting messages over their
// existing connection.
export function leaveUserSocketsFromConversation(io: Server, userId: string, conversationId: string): void {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  for (const socketId of sockets) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue;
    s.leave(`conversation:${conversationId}`);
    conversationSockets.get(conversationId)?.delete(socketId);
    socketConversations.get(socketId)?.delete(conversationId);
  }
}

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

    // Join a per-user room so we can emit targeted events (conversation:created,
    // participant:added) without requiring prior conversation:join. Fixes the
    // new-DM discovery race (OpenChat-09h).
    socket.join(`user:${userId}`);

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

        // Ensure socketConversations entry exists (may be missing after reconnect)
        if (!socketConversations.has(socket.id)) {
          socketConversations.set(socket.id, new Set());
        }
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
        // Verify participation AND check for block (OpenChat-46p):
        // If any recipient in a direct conversation has blocked the sender,
        // silently drop the message (no error to sender).
        const check = await session.run(`
          MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
          RETURN c,
            exists {
              MATCH (other:User)-[:PARTICIPATES_IN]->(c)
              WHERE other.id <> $userId AND (other)-[:BLOCKED]->(u)
            } AS blockedBySomeone
        `, { userId, conversationId });

        if (check.records.length === 0) {
          callback?.({ error: 'Not a participant' });
          return;
        }

        // Silently drop if blocked — return success to sender but don't persist or fan out.
        if (check.records[0].get('blockedBySomeone') === true) {
          callback?.({ success: true, dropped: true });
          return;
        }

        const messageId = nanoid();
        const now = new Date().toISOString();

        // --- Mention parsing (OpenChat-0jy) ---
        // Only parse mentions in group conversations; DMs don't need them.
        // We resolve @Name tokens to participant userIds by name match so the
        // stored list survives display-name changes in rendering logic.
        const convCheckResult = await session.run(`
          MATCH (c:Conversation {id: $conversationId})
          RETURN c.type AS convType
        `, { conversationId });
        const convType = convCheckResult.records[0]?.get('convType') as string | null;
        const isGroupConv = convType === 'group';

        let mentionedUserIds: string[] = [];
        if (isGroupConv) {
          const mentionTokens = [...content.matchAll(/@([\w-]+(?:\s+[\w-]+)?)/g)].map(m => m[1]);
          if (mentionTokens.length > 0) {
            // Resolve each token to a participant by case-insensitive name match.
            // We fetch all participants at once and do the match in JS to avoid
            // multiple round-trips. Names with spaces are intentionally supported
            // (e.g. "@Alice Smith") but single-word tokens (e.g. "@alice") also work.
            const participantsResult = await session.run(`
              MATCH (p:User)-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
              WHERE p.id <> $senderId
              RETURN p.id AS pid, p.name AS pname, p.email AS pemail
            `, { conversationId, senderId: userId });
            const participants = participantsResult.records.map(r => ({
              id: r.get('pid') as string,
              name: (r.get('pname') as string | null) || '',
              email: (r.get('pemail') as string | null) || '',
            }));
            for (const token of mentionTokens) {
              const lower = token.toLowerCase();
              const matched = participants.find(p =>
                p.name.toLowerCase() === lower ||
                p.name.toLowerCase().startsWith(lower) ||
                p.email.split('@')[0].toLowerCase() === lower
              );
              if (matched && !mentionedUserIds.includes(matched.id)) {
                mentionedUserIds.push(matched.id);
              }
            }
          }
        }

        const result = await session.run(`
          MATCH (c:Conversation {id: $conversationId})
          MATCH (sender:User {id: $senderId})
          CREATE (m:Message {
            id: $id,
            content: $content,
            senderId: $senderId,
            conversationId: $conversationId,
            messageType: $messageType,
            mentions: $mentions,
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
          mentions: mentionedUserIds,
          now
        });

        const message = convertToJS(result.records[0].get('message'));

        // Broadcast to all participants in the conversation
        io.to(`conversation:${conversationId}`).emit('message:new', message);

        // Async link preview fetch — non-blocking (OpenChat-hq2)
        processLinkPreviews(io, messageId, conversationId, content);

        callback?.({ success: true, message });

        // Fan-out push notifications to all OTHER participants. Fire-and-forget;
        // never block the message:send response on push delivery.
        // The mobile client's foreground handler suppresses the banner when the
        // user is already viewing the conversation. (OpenChat-vg7)
        fanoutPushForMessage(conversationId, userId, message, mentionedUserIds).catch((err) => {
          console.warn('[push] fanout error:', err);
        });
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

/**
 * Send push notifications to every participant of a conversation except the
 * sender. Title is the sender name (falling back to email), body is the
 * message preview. Data carries conversationId + messageId so the mobile
 * client can navigate to the right thread on tap.
 *
 * For mentioned users in group chats the notification body reads:
 *   "You were mentioned in {convTitle} by {senderName}: {preview}"
 * vs the default "{senderName} in {convTitle}: {preview}".
 *
 * Fire-and-forget — logs but never throws to the caller.
 * OpenChat-0jy: added mentionedUserIds param.
 */
async function fanoutPushForMessage(
  conversationId: string,
  senderId: string,
  message: unknown,
  mentionedUserIds: string[] = []
): Promise<void> {
  const m = message as {
    id?: string;
    content?: string;
    sender?: { name?: string; email?: string };
  };
  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (c:Conversation {id: $conversationId})
      OPTIONAL MATCH (other:User)-[:PARTICIPATES_IN]->(c)
      WHERE other.id <> $senderId
      RETURN c { .title, .type } AS conv, collect(other.id) AS recipientIds
      `,
      { conversationId, senderId }
    );
    if (result.records.length === 0) return;
    const recipientIds = (result.records[0].get('recipientIds') as string[]) || [];
    const conv = result.records[0].get('conv') as { title?: string; type?: string } | null;
    if (recipientIds.length === 0) return;

    const senderName = (m.sender?.name || m.sender?.email || 'Someone').trim();
    const preview = (m.content || '').slice(0, 140);
    const mentionSet = new Set(mentionedUserIds);

    await Promise.all(
      recipientIds.map((uid) => {
        const isMentioned = mentionSet.has(uid);
        let title: string;
        let body: string;

        if (isMentioned && conv?.type === 'group') {
          // Mention-specific copy (OpenChat-0jy)
          const convTitle = conv.title ? ` in ${conv.title}` : '';
          title = `${senderName}${convTitle}`;
          body = `You were mentioned by ${senderName}: ${preview}`;
        } else {
          title =
            conv?.type === 'group' && conv.title
              ? `${senderName} in ${conv.title}`
              : senderName;
          body = preview;
        }

        return sendPushToUser(uid, {
          title,
          body,
          tag: `conv:${conversationId}`,
          data: {
            type: isMentioned ? 'mention' : 'message',
            conversationId,
            messageId: m.id,
            isMention: isMentioned,
          },
        }).catch((err) => {
          console.warn(`[push] send to ${uid} failed:`, err);
          return { delivered: 0, removed: 0, failed: 1 };
        });
      })
    );
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
