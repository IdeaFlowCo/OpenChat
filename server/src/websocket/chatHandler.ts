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

// Broadcast a message:new to every participant of a conversation via their
// per-user room (user:<id>), which each socket joins on connect. This reaches
// recipients who are connected but have NOT opened (joined the room of) the
// conversation — unlike emitting to conversation:<id>, which only reaches
// sockets that ran conversation:join. Chained .to() unions the rooms so a
// socket in several matched rooms still receives exactly one copy.
// See OpenChat-60y.
export function broadcastMessageToParticipants(
  io: Server,
  participantIds: string[],
  message: unknown
): void {
  if (!participantIds.length) return;
  let op = io.to(`user:${participantIds[0]}`);
  for (let i = 1; i < participantIds.length; i++) {
    op = op.to(`user:${participantIds[i]}`);
  }
  op.emit('message:new', message);
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
    socket.on('message:send', async (data: { conversationId: string; content: string; messageType?: string; id?: string }, callback) => {
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

        // Idempotency: the client supplies a stable message id used by BOTH the
        // WebSocket path and the REST fallback. MERGE (create-if-absent) makes a
        // duplicate send (e.g. WS ack lost -> client retries over REST) collapse
        // to one row instead of persisting twice with different ids. See
        // OpenChat-60y. Fall back to a server id for older clients.
        const messageId = (typeof data.id === 'string' && data.id) || nanoid();
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
          MERGE (m:Message {id: $id})
          ON CREATE SET
            m.content = $content,
            m.senderId = $senderId,
            m.conversationId = $conversationId,
            m.messageType = $messageType,
            m.mentions = $mentions,
            m.createdAt = datetime($now)
          MERGE (m)-[:IN_CONVERSATION]->(c)
          MERGE (sender)-[:SENT]->(m)
          SET c.updatedAt = datetime($now),
              c.lastMessageAt = datetime($now),
              c.lastMessagePreview = left(m.content, 100)
          WITH c, m, sender
          MATCH (p:User)-[:PARTICIPATES_IN]->(c)
          RETURN m { .*, sender: sender { .id, .name, .email } } AS message,
                 collect(DISTINCT p.id) AS participantIds
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
        const participantIds = result.records[0].get('participantIds') as string[];

        // Broadcast to every participant's per-user room (reaches recipients who
        // haven't joined the conversation room). See OpenChat-60y.
        broadcastMessageToParticipants(io, participantIds, message);

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
    // OpenChat-aes: collect each non-sender's mutedUntil so we can filter
    // out muted recipients before fanning out. mutedUntil is either:
    //   - null (not muted)
    //   - 'always' (muted indefinitely → never push)
    //   - ISO timestamp (muted until that point → check against now)
    const result = await session.run(
      `
      MATCH (c:Conversation {id: $conversationId})
      OPTIONAL MATCH (other:User)-[rel:PARTICIPATES_IN]->(c)
      WHERE other.id <> $senderId
      RETURN c { .title, .type } AS conv,
             collect({ id: other.id, mutedUntil: rel.mutedUntil }) AS recipients
      `,
      { conversationId, senderId }
    );
    if (result.records.length === 0) return;
    const rawRecipients = (result.records[0].get('recipients') as Array<{ id: string; mutedUntil: string | null }>) || [];
    const conv = result.records[0].get('conv') as { title?: string; type?: string } | null;
    const now = Date.now();
    // Mentioned users break through mute (standard chat-app behavior:
    // muting silences the room but @-mentions are explicit attention asks).
    const mentionAllowSet = new Set(mentionedUserIds);
    const recipientIds = rawRecipients
      .filter((r) => {
        if (!r.id) return false;
        if (mentionAllowSet.has(r.id)) return true;
        if (!r.mutedUntil) return true;
        if (r.mutedUntil === 'always') return false;
        const until = Date.parse(r.mutedUntil);
        return Number.isNaN(until) ? true : now >= until;
      })
      .map((r) => r.id);
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
