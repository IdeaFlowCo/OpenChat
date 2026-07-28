import { Router, Request, Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';
import neo4j from 'neo4j-driver';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { joinUserSocketsToConversation, leaveUserSocketsFromConversation, isUserOnline, broadcastMessageToParticipants } from '../websocket/chatHandler.js';
import { processLinkPreviews, loadPreviewsForMessages } from '../services/linkPreview.js';
import { createThoughtsFromMessageTags } from '../services/extractThoughtsFromMessage.js';
import { maybeTriggerAssistant } from '../services/assistantTrigger.js';
import { dispatchMessageEvent } from '../services/webhookDispatch.js';
import { embedAndStoreMessage, semanticSearchMessages, embeddingsEnabled } from '../services/embeddings.js';
import { maybeTranscribeMessage } from '../services/transcribeVoice.js';
import { CONVERSATIONS_QUERY, UNREAD_TOTAL_QUERY } from '../queries/chatUnread.js';

// ─── S3/GCS client (lazy-initialised on first use) ───────────────────────────
let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (_s3) return _s3;
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.AWS_REGION || 'auto';
  _s3 = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' } : {}),
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        }
      : undefined,
  });
  return _s3;
}

const router = Router();

const EXPORT_RANGES = {
  last_hour: { label: 'Last hour', ms: 60 * 60 * 1000 },
  last_day: { label: 'Last day', ms: 24 * 60 * 60 * 1000 },
  last_week: { label: 'Last week', ms: 7 * 24 * 60 * 60 * 1000 },
  last_month: { label: 'Last month', ms: 30 * 24 * 60 * 60 * 1000 },
  all_time: { label: 'All time', ms: null },
} as const;

type ExportRange = keyof typeof EXPORT_RANGES;

function parseExportRange(raw: unknown): ExportRange | null {
  const value = typeof raw === 'string' ? raw : 'last_day';
  return value in EXPORT_RANGES ? value as ExportRange : null;
}

function exportSince(range: ExportRange): string | null {
  const ms = EXPORT_RANGES[range].ms;
  if (ms === null) return null;
  return new Date(Date.now() - ms).toISOString();
}

function safeFilenamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation';
}

function sendJsonDownload(res: Response, filename: string, payload: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(payload);
}

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
// Omits DM conversations where the other participant has blocked me (OpenChat-46p).
// Includes containsBot field (OpenChat-ds3).
router.get('/conversations', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const result = await session.run(CONVERSATIONS_QUERY, { userId });

    const conversations = result.records.map(r => toJS(r.get('conversation')));
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/unread-total - Total unread messages for the navbar badge.
// JWT-only: embedded clients mint a short-lived user JWT before polling.
router.get('/unread-total', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const result = await session.run(UNREAD_TOTAL_QUERY, { userId });
    const unreadTotal = result.records[0]?.get('unreadTotal');
    res.json({ unreadTotal: unreadTotal ? toJS(unreadTotal) : 0 });
  } catch (error) {
    console.error('Error fetching unread total:', error);
    res.status(500).json({ error: 'Failed to fetch unread total' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/conversations - Create a conversation (1:1 or group)
router.post('/conversations', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { participantIds, title, type = 'direct' } = req.body;

  if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
    res.status(400).json({ error: 'participantIds required' });
    return;
  }

  // For direct messages, check if conversation already exists.
  if (type === 'direct' && participantIds.length === 1) {
    const otherId = participantIds[0];

    // Self-DM dedupe (OpenChat-self-1, codex 2026-06-01): the two-user
    // pattern below requires u1 != u2 in the graph. For a self-DM (one
    // participant edge) it would never match → repeated POSTs would
    // create duplicate self-DMs. Special-case before the normal path.
    if (otherId === userId) {
      const selfExisting = await session.run(`
        MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {type: 'direct'})
        WHERE NOT EXISTS {
          MATCH (other:User)-[:PARTICIPATES_IN]->(c) WHERE other.id <> $userId
        }
        MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
        WITH c, collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
        RETURN c { .*, participants: participants } AS conversation
        LIMIT 1
      `, { userId });

      if (selfExisting.records.length > 0) {
        const conv = toJS(selfExisting.records[0].get('conversation')) as Record<string, unknown> | null;
        await session.close();
        const io = req.app.get('io') as IOServer | undefined;
        const existingId = typeof conv?.id === 'string' ? conv.id : null;
        if (io && existingId) joinUserSocketsToConversation(io, userId, existingId);
        res.json(conv);
        return;
      }
      // No existing self-DM found → fall through to creation with the
      // single-edge model (allParticipants below filters self → empty,
      // then we add the one edge explicitly).
    }

    const existing = await session.run(`
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      WHERE c.type = 'direct'
      WITH c, collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
      WITH c, participants, [p IN participants | p.user.id] AS participantIds
      WHERE (
        $otherId = $userId
        AND size(participantIds) = 1
        AND $userId IN participantIds
      ) OR (
        $otherId <> $userId
        AND size(participantIds) = 2
        AND $userId IN participantIds
        AND $otherId IN participantIds
      )
      RETURN c {
        .*,
        participants: participants
      } AS conversation
    `, { userId, otherId });

    if (existing.records.length > 0) {
      const conv = toJS(existing.records[0].get('conversation')) as Record<string, unknown> | null;
      await session.close();
      // Auto-join the live sockets of BOTH participants to the existing DM's
      // conversation room. Without this, a client that re-requests a DM via
      // POST /conversations (e.g. on first open from a fresh socket) and
      // then immediately sends a message has the message broadcast to a
      // conversation room nobody is in — recipient never sees it until they
      // explicitly conversation:join. Same race as the group-creation
      // auto-join below but for the dedupe path. Caught by multi-account
      // e2e test (server/test-multi-account-e2e.mjs).
      const io = req.app.get('io') as IOServer | undefined;
      const existingId = typeof conv?.id === 'string' ? conv.id : null;
      if (io && existingId) {
        joinUserSocketsToConversation(io, userId, existingId);
        joinUserSocketsToConversation(io, otherId, existingId);
      }
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
      WITH c, collect({user: u {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
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

    // Force-join every participant's live sockets to the conversation room
    // immediately. Without this, the very first message:send from the creator
    // is broadcast to conversation:${id} *before* the other participants'
    // clients react to conversation:created → conversation:join, and the
    // message is dropped for them. (Same race as OpenChat-09h, but for group
    // creation. POST /participants does this for add-member; creation needs
    // it too.) See OpenChat-22u.
    if (io) {
      for (const pid of allParticipants) {
        joinUserSocketsToConversation(io, pid, conversationId);
      }
    }

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
      ELSE {user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}
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

// PATCH /api/chat/conversations/:id/participants/me — set mute state for
// the calling user on this conversation (OpenChat-aes). Body:
//   { mutedUntil: ISO-8601 string | 'always' | null }
// Stored as a property on the user's PARTICIPATES_IN edge. Other devices
// of the same user pick it up on next /conversations refresh.
router.patch('/conversations/:id/participants/me', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const { mutedUntil } = (req.body ?? {}) as { mutedUntil?: string | null };

  // Validate: either null (unmute), 'always' (forever), or an ISO timestamp
  // in the future. Reject obvious garbage early.
  let muteValue: string | null;
  if (mutedUntil === null || mutedUntil === undefined) {
    muteValue = null;
  } else if (typeof mutedUntil !== 'string') {
    res.status(400).json({ error: 'mutedUntil must be a string, "always", or null' });
    return;
  } else if (mutedUntil === 'always') {
    muteValue = 'always';
  } else {
    const parsed = Date.parse(mutedUntil);
    if (Number.isNaN(parsed)) {
      res.status(400).json({ error: 'mutedUntil must be a valid ISO-8601 string, "always", or null' });
      return;
    }
    muteValue = new Date(parsed).toISOString();
  }

  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $id})
       SET rel.mutedUntil = $muteValue
       RETURN rel.mutedUntil AS mutedUntil, c.id AS conversationId`,
      { userId, id, muteValue }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.json({
      conversationId: result.records[0].get('conversationId'),
      mutedUntil: result.records[0].get('mutedUntil'),
    });
  } catch (error) {
    console.error('Error updating mute state:', error);
    res.status(500).json({ error: 'Failed to update mute state' });
  } finally {
    await session.close();
  }
});

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
router.get('/conversations/:id', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id } = req.params;

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $id})
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      RETURN c, collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
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

// GET /api/chat/conversations/:id/export?range=last_day
// Download a user's copy of one conversation's recent history. The participant
// check mirrors the read endpoints; no messages from conversations the user
// is no longer in are exported.
router.get('/conversations/:id/export', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id } = req.params;
  const range = parseExportRange(req.query.range);

  if (!range) {
    res.status(400).json({ error: `range must be one of: ${Object.keys(EXPORT_RANGES).join(', ')}` });
    return;
  }

  const since = exportSince(range);

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $id})
      CALL {
        WITH c
        MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
        RETURN collect({
          user: participant { .id, .name, .email, .isBot },
          role: rel.role,
          joinedAt: rel.joinedAt
        }) AS participants
      }
      CALL {
        WITH c
        MATCH (m:Message {conversationId: c.id})
        WHERE $since IS NULL OR m.createdAt >= datetime($since)
        MATCH (sender:User {id: m.senderId})
        OPTIONAL MATCH (reactor:User)-[reaction:REACTED]->(m)
        WITH m, sender, collect({
          emoji: reaction.emoji,
          kind: reaction.kind,
          href: reaction.href,
          userId: reactor.id,
          name: reactor.name,
          email: reactor.email
        }) AS rawReactions
        RETURN collect(m {
          .*,
          sender: sender { .id, .name, .email, .isBot },
          reactions: [r IN rawReactions WHERE r.emoji IS NOT NULL]
        }) AS messages
      }
      RETURN c { .*, participants: participants } AS conversation, messages
    `, { userId, id, since });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const conversation = toJS(result.records[0].get('conversation')) as Record<string, unknown>;
    const messages = (toJS(result.records[0].get('messages')) as Record<string, unknown>[])
      .map((msg) => {
        if (typeof msg.attachments === 'string') {
          try { msg.attachments = JSON.parse(msg.attachments); } catch { /* leave raw */ }
        }
        return msg;
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    if (messages.length > 0) {
      const previewMap = await loadPreviewsForMessages(messages.map(m => m.id as string));
      for (const msg of messages) {
        const previews = previewMap.get(msg.id as string);
        if (previews?.length) msg.linkPreviews = previews;
      }
    }

    const title = typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title
      : conversation.type === 'direct'
        ? 'direct-chat'
        : 'group-chat';
    const exportedAt = new Date().toISOString();

    sendJsonDownload(res, `openchat-${safeFilenamePart(title)}-${range}.json`, {
      schema: 'openchat.conversation_export.v1',
      exportedAt,
      range: { key: range, label: EXPORT_RANGES[range].label, since },
      conversation,
      messageCount: messages.length,
      messages,
    });
  } catch (error) {
    console.error('Error exporting conversation:', error);
    res.status(500).json({ error: 'Failed to export conversation' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/conversations/:id/messages - Get messages (paginated)
router.get('/conversations/:id/messages', resolveActor, async (req: Request, res: Response) => {
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

    // OpenChat-uxj: hydrate reply target inline so clients render reply
    // quote bubbles without an extra round-trip per message.
    const replyHydrate = `
        CALL {
          WITH m
          OPTIONAL MATCH (reply:Message {id: m.replyToId})
          OPTIONAL MATCH (replySender:User)-[:SENT]->(reply)
          RETURN CASE
            WHEN reply IS NULL THEN NULL
            ELSE {
              id: reply.id,
              content: left(reply.content, 200),
              senderId: reply.senderId,
              sender: { id: replySender.id, name: replySender.name, email: replySender.email },
              messageType: reply.messageType
            }
          END AS replyTo
        }`;

    const query = before
      ? `
        MATCH (m:Message {conversationId: $id})
        WHERE m.createdAt < datetime($before)
        MATCH (sender:User {id: m.senderId})
        CALL {
          WITH m
          OPTIONAL MATCH (reactor:User)-[r:REACTED]->(m)
          WITH r.emoji AS emoji, r.kind AS kind, r.href AS href, count(*) AS cnt, collect(reactor.id) AS reactors
          WHERE emoji IS NOT NULL
          RETURN collect({ emoji: emoji, count: cnt, byMe: $userId IN reactors, kind: kind, href: href }) AS reactions
        }
        ${replyHydrate}
        RETURN m { .*, sender: sender { .id, .name, .email }, reactions: reactions, replyTo: replyTo } AS message
        ORDER BY m.createdAt DESC
        LIMIT $limit
      `
      : `
        MATCH (m:Message {conversationId: $id})
        MATCH (sender:User {id: m.senderId})
        CALL {
          WITH m
          OPTIONAL MATCH (reactor:User)-[r:REACTED]->(m)
          WITH r.emoji AS emoji, r.kind AS kind, r.href AS href, count(*) AS cnt, collect(reactor.id) AS reactors
          WHERE emoji IS NOT NULL
          RETURN collect({ emoji: emoji, count: cnt, byMe: $userId IN reactors, kind: kind, href: href }) AS reactions
        }
        ${replyHydrate}
        RETURN m { .*, sender: sender { .id, .name, .email }, reactions: reactions, replyTo: replyTo } AS message
        ORDER BY m.createdAt DESC
        LIMIT $limit
      `;

    const result = await session.run(query, { id, limit: neo4j.int(limit), before, userId });
    const messages = result.records.map(r => {
      const msg = toJS(r.get('message')) as Record<string, unknown>;
      if (msg && typeof msg.attachments === 'string') {
        try { msg.attachments = JSON.parse(msg.attachments as string); } catch { /* leave as string */ }
      }
      return msg;
    }).reverse();

    // Attach link previews (OpenChat-hq2)
    if (messages.length > 0) {
      const ids = messages.map(m => m.id as string);
      const previewMap = await loadPreviewsForMessages(ids);
      for (const msg of messages) {
        const previews = previewMap.get(msg.id as string);
        if (previews && previews.length > 0) {
          msg.linkPreviews = previews;
        }
      }
    }

    // hasMore: if we got exactly `limit` records back, there are probably older
    // messages. We don't run a separate COUNT query for perf — one extra fetch
    // that returns 0 rows is the acceptable edge case.
    const hasMore = result.records.length === limit;
    res.json({ messages, hasMore });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  } finally {
    await session.close();
  }
});

// PATCH /api/chat/conversations/:id/read — mark caller's lastReadAt = now (OpenChat-0nj)
// Also returns per-participant lastReadAt map and online status so the client
// can infer tick state without a separate round-trip.
router.patch('/conversations/:id/read', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id: conversationId } = req.params;
  const now = new Date().toISOString();

  try {
    // Verify user is participant and update their lastReadAt on the edge.
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      SET rel.lastReadAt = datetime($now)
      RETURN c
    `, { userId, conversationId, now });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Fetch all participant lastReadAt values to include in the emit.
    const participantResult = await session.run(`
      MATCH (u:User)-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      RETURN u.id AS userId, rel.lastReadAt AS lastReadAt
    `, { conversationId });

    const readMap: Record<string, string | null> = {};
    const onlineMap: Record<string, boolean> = {};
    for (const r of participantResult.records) {
      const uid = r.get('userId') as string;
      const raw = r.get('lastReadAt');
      readMap[uid] = raw ? toJS(raw) as string : null;
      onlineMap[uid] = isUserOnline(uid);
    }

    const io = req.app.get('io') as IOServer | undefined;
    if (io) {
      // Emit to all participants in the conversation room.
      io.to(`conversation:${conversationId}`).emit('read:updated', {
        conversationId,
        userId,
        lastReadAt: now,
        readMap,
        onlineMap,
      });
    }

    res.json({ ok: true, lastReadAt: now, readMap, onlineMap });
  } catch (error) {
    console.error('Error marking read:', error);
    res.status(500).json({ error: 'Failed to mark read' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/conversations/:id/messages - Send a message
router.post('/conversations/:id/messages', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { id: conversationId } = req.params;
  const { content: rawContent, text, messageType = 'text', attachments, id: clientId, replyToId } = req.body;
  const content = rawContent ?? text;

  // Allow either content OR attachments (images can be sent without caption).
  const hasContent = content && typeof content === 'string' && content.trim();
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!hasContent && !hasAttachments) {
    res.status(400).json({ error: 'content or attachments is required' });
    return;
  }

  // Validate replyToId shape if present (OpenChat-uxj). We verify it
  // points to a real message in the SAME conversation below — pre-check
  // here just rejects obvious bad input early.
  if (replyToId !== undefined && replyToId !== null && typeof replyToId !== 'string') {
    res.status(400).json({ error: 'replyToId must be a string' });
    return;
  }

  // Validate attachments shape if present
  if (hasAttachments) {
    for (const a of attachments as unknown[]) {
      const att = a as Record<string, unknown>;
      if (!att.url || typeof att.url !== 'string') {
        res.status(400).json({ error: 'Each attachment must have a url' });
        return;
      }
      if (!att.mimeType || typeof att.mimeType !== 'string') {
        res.status(400).json({ error: 'Each attachment must have a mimeType' });
        return;
      }
    }
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

    // Validate replyToId points to a message in THIS conversation
    // (OpenChat-uxj). Cross-conversation replies are rejected — they'd
    // leak content from a chat the recipients aren't part of.
    if (replyToId) {
      const replyCheck = await session.run(
        `MATCH (m:Message {id: $replyToId})-[:IN_CONVERSATION]->(c:Conversation {id: $conversationId})
         RETURN m.id AS id`,
        { replyToId, conversationId }
      );
      if (replyCheck.records.length === 0) {
        res.status(400).json({ error: 'replyToId does not point to a message in this conversation' });
        return;
      }
    }

    // Idempotency: use the client-supplied id (shared with the WebSocket path)
    // so a WS send whose ack was lost, then retried over this REST fallback,
    // collapses to one row via MERGE instead of persisting a duplicate with a
    // fresh nanoid. See OpenChat-60y.
    const messageId = (typeof clientId === 'string' && clientId) || nanoid();
    const now = new Date().toISOString();
    // Use caption or fallback for preview
    const messageContent = hasContent ? (content as string).trim() : '';
    // attachmentsJson stored as a JSON string in Neo4j
    const attachmentsJson = hasAttachments ? JSON.stringify(attachments) : null;
    // lastMessagePreview for image-only messages
    const preview = messageContent || (hasAttachments ? '📷 Photo' : '');

    const result = await session.run(`
      MATCH (c:Conversation {id: $conversationId})
      MATCH (sender:User {id: $senderId})
      MERGE (m:Message {id: $id})
      ON CREATE SET
        m.content = $content,
        m.senderId = $senderId,
        m.conversationId = $conversationId,
        m.messageType = $messageType,
        m.attachments = $attachmentsJson,
        m.replyToId = $replyToId,
        m.createdAt = datetime($now),
        m._created = true
      MERGE (m)-[:IN_CONVERSATION]->(c)
      MERGE (sender)-[:SENT]->(m)
      SET c.updatedAt = datetime($now),
          c.lastMessageAt = datetime($now),
          c.lastMessagePreview = left($preview, 100)
      // OpenChat-uxj: hydrate the reply target so clients can render the
      // quote bubble without an extra fetch. OpenChat-60y: also return the
      // participant ids so we can fan out to per-user rooms.
      WITH c, m, sender, coalesce(m._created, false) AS wasCreated
      REMOVE m._created
      WITH c, m, sender, wasCreated
      OPTIONAL MATCH (reply:Message {id: m.replyToId})
      OPTIONAL MATCH (replySender:User)-[:SENT]->(reply)
      MATCH (p:User)-[:PARTICIPATES_IN]->(c)
      RETURN m {
        .*,
        sender: sender { .id, .name, .email },
        replyTo: CASE
          WHEN reply IS NULL THEN NULL
          ELSE {
            id: reply.id,
            content: left(reply.content, 200),
            senderId: reply.senderId,
            senderName: replySender.name,
            messageType: reply.messageType
          }
        END
      } AS message,
      collect(DISTINCT p.id) AS participantIds,
      wasCreated
    `, {
      id: messageId,
      content: messageContent,
      senderId: userId,
      conversationId,
      messageType,
      now,
      attachmentsJson,
      replyToId: replyToId ?? null,
      preview,
    });

    const message = toJS(result.records[0].get('message')) as Record<string, unknown>;
    const participantIds = result.records[0].get('participantIds') as string[];
    const wasCreated = result.records[0].get('wasCreated') === true;
    // Parse attachments JSON string back to array for the response + broadcast
    if (message && typeof message.attachments === 'string') {
      try { message.attachments = JSON.parse(message.attachments as string); } catch { /* leave as string */ }
    }

    const io = req.app.get('io') as IOServer | undefined;
    // Deliver live to every participant's per-user room, exactly like the
    // WebSocket handler. Without this, messages sent via the REST fallback
    // (mobile users on a China VPN where the WS upgrade is blocked/reset) are
    // persisted but never delivered live. Clients dedupe by message.id, so the
    // sender receiving its own broadcast is harmless. See OpenChat-5q1 / -60y.
    if (io) broadcastMessageToParticipants(io, participantIds, message);
    // Outbound webhooks (openchat bot-channel): push the message to any external
    // subscriber (e.g. groupbrain). Fire-and-forget, no-ops when no subscription.
    if (wasCreated) dispatchMessageEvent(message, participantIds);
    // Async link preview fetch — non-blocking (OpenChat-hq2)
    if (io) {
      processLinkPreviews(io, message.id as string, conversationId as string, messageContent);
    }
    // Voice transcription — non-blocking, best-effort (openchat-4jn). Whisper
    // transcribes any audio attachment and emits message:transcript.
    if (hasAttachments) {
      void maybeTranscribeMessage(io, message.id as string, conversationId as string, attachments).catch(
        () => { /* best-effort */ }
      );
    }

    // Hashtag → Thought extraction (OpenChat-thoughts-from-tags). Best-
    // effort: errors here log but never break the message send. Fired on
    // a fresh session so we don't block the response. Pass the IO server
    // so each created Thought emits 'thought:created' to the sender's
    // user room → Thoughts tab refreshes live without polling.
    if (messageContent) {
      const tagSession = getDriver().session();
      void createThoughtsFromMessageTags(tagSession, {
        senderId: userId,
        messageId: message.id as string,
        conversationId: conversationId as string,
        content: messageContent,
        io,
      })
        .catch((err) => console.warn('[thought-from-tag] background create failed:', err))
        .finally(() => { void tagSession.close(); });
    }

    // Semantic search (openchat-bfn.2): best-effort embed of the new message.
    // Fire-and-forget; never blocks the send. No-ops if OPENAI_API_KEY unset.
    if (messageContent) {
      void embedAndStoreMessage(message.id as string, messageContent)
        .catch((err) => console.warn('[embeddings] REST embed failed:', err));
    }

    // In-app Assistant bot (openchat-bfn.3): if this conversation contains the
    // bot, fire an assistant turn asynchronously. No-ops when the sender is the
    // bot itself (loop guard inside maybeTriggerAssistant).
    maybeTriggerAssistant({ senderId: userId, conversationId: conversationId as string, io });

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
router.get('/contacts', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const searchQuery = req.query.q as string | undefined;
  const normalizedSearch = (searchQuery || '').trim().toLowerCase();
  const isSelfSearch = normalizedSearch === 'self' || normalizedSearch === 'me';

  try {
    // Self is ALWAYS discoverable so you can DM yourself ("note to self"):
    //  - empty query  -> everyone incl. you, you pinned first
    //  - searching     -> others matching name/email, PLUS you if you match
    //    name/email or typed the magic words "self"/"me". You always rank first.
    const query = `
        MATCH (u:User)
        WHERE
          $search = ''
          OR (
            u.id <> $userId
            AND (toLower(u.name) CONTAINS toLower($search) OR toLower(u.email) CONTAINS toLower($search))
          )
          OR (
            u.id = $userId
            AND ($isSelfSearch = true
                 OR toLower(u.name) CONTAINS toLower($search)
                 OR toLower(u.email) CONTAINS toLower($search))
          )
        RETURN u { .id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot } AS user
        ORDER BY CASE WHEN u.id = $userId THEN 0 ELSE 1 END, u.name
      `;

    const result = await session.run(query, { userId, search: (searchQuery || '').trim(), isSelfSearch });
    const contacts = result.records.map(r => toJS(r.get('user')));
    res.json(contacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/search - Unified search across messages, conversations, and contacts
//
// Query params:
//   q              - search text (required)
//   scope          - 'global' | 'conversation' (default 'global')
//   conversationId - required when scope='conversation'
//   limit          - per-bucket cap (default 20, max 100)
//
// Authorization:
//   - Messages: only ones in conversations where the requesting user
//     PARTICIPATES_IN. The :PARTICIPATES_IN filter in the Cypher is the
//     access-control boundary; without it this endpoint would leak every
//     message in the graph.
//   - Conversations: same — only conversations the user is a member of are
//     considered, and we match by title.
//   - Contacts: all users by name/email (already public-by-design via
//     /contacts).
//
// Backed by CONTAINS (case-insensitive via toLower) rather than a Neo4j
// full-text index. Reasoning: CONTAINS works against the existing schema
// without a migration, and the message corpus is small for now. We can
// add a fulltext index in a follow-up pass once volume justifies it.
router.get('/search', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const rawQ = (req.query.q ?? '') as string;
  const q = typeof rawQ === 'string' ? rawQ.trim() : '';
  const scope = (req.query.scope as string) === 'conversation' ? 'conversation' : 'global';
  const conversationId = req.query.conversationId as string | undefined;
  // openchat-bfn.2: optional semantic/hybrid mode for the messages bucket.
  // DEFAULT (unset / 'keyword') keeps the existing behavior unchanged.
  const rawMode = (req.query.mode as string) || 'keyword';
  const mode = rawMode === 'semantic' || rawMode === 'hybrid' ? rawMode : 'keyword';
  const rawLimit = parseInt(req.query.limit as string, 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);

  if (!q) {
    res.status(400).json({ error: 'q is required' });
    return;
  }
  // Guardrail: refuse single-character queries. CONTAINS on a single char
  // scans almost every message; we keep it cheap. Two chars is a reasonable
  // floor for "intent to search".
  if (q.length < 2) {
    res.json({ messages: [], conversations: [], contacts: [] });
    return;
  }
  if (scope === 'conversation' && !conversationId) {
    res.status(400).json({ error: 'conversationId is required when scope=conversation' });
    return;
  }

  const session = getDriver().session();
  try {
    if (scope === 'conversation') {
      // Verify access first to keep the not-found / forbidden cases separable
      // from "empty results".
      const accessCheck = await session.run(`
        MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
        RETURN c
      `, { userId, conversationId });

      if (accessCheck.records.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const result = await session.run(`
        MATCH (m:Message {conversationId: $conversationId})
        WHERE m.deletedAt IS NULL
          AND toLower(m.content) CONTAINS toLower($q)
        MATCH (sender:User {id: m.senderId})
        RETURN m {
          .id, .content, .conversationId, .senderId, .createdAt,
          sender: sender { .id, .name, .email, .isBot }
        } AS message
        ORDER BY m.createdAt DESC
        LIMIT $limit
      `, { conversationId, q, limit: neo4j.int(limit) });

      const messages = result.records.map(r => toJS(r.get('message')));
      res.json({ messages, conversations: [], contacts: [] });
      return;
    }

    // openchat-bfn.2: semantic/hybrid mode for the messages bucket. We still
    // return conversations + contacts via the keyword queries below; only the
    // messages bucket switches to vector search. If embeddings are unavailable
    // (no OPENAI_API_KEY / embed failed), we silently fall through to keyword
    // so behavior degrades gracefully.
    let semanticMessages: unknown[] | null = null;
    if ((mode === 'semantic' || mode === 'hybrid') && embeddingsEnabled()) {
      const hits = await semanticSearchMessages(userId, q, limit);
      if (hits) {
        semanticMessages = hits.map((h) => ({
          content: h.content,
          conversationId: h.conversationId,
          senderName: h.senderName ?? null,
          createdAt: h.createdAt,
          score: h.score,
        }));
      }
    }

    // Global scope: run three independent searches in parallel.
    //
    // Notes:
    // - Messages query filters on PARTICIPATES_IN, so a user can never get
    //   back a message from a conversation they're not in.
    // - Conversations matches on the conversation TITLE only (participant
    //   names already surface via the contacts bucket; layering them in
    //   here causes confusing double-counted results).
    // - Contacts excludes self, matching the existing /contacts behavior.
    //
    // Each query runs on its OWN session: a single Neo4j session cannot run
    // multiple queries concurrently (Promise.all on one session throws
    // "Queries cannot be run directly on a session with an open transaction").
    const runQ = (cypher: string, params: Record<string, unknown>) => {
      const s = getDriver().session();
      return s.run(cypher, params).finally(() => s.close());
    };
    const [messagesResult, conversationsResult, contactsResult] = await Promise.all([
      // Match messages by the conversationId PROPERTY (always set), not the
      // IN_CONVERSATION relationship — the socket send path and others only set
      // the property, so a relationship join silently misses most messages.
      runQ(`
        MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
        WITH collect(c.id) AS cids
        MATCH (m:Message)
        WHERE m.conversationId IN cids
          AND m.deletedAt IS NULL
          AND toLower(m.content) CONTAINS toLower($q)
        MATCH (sender:User {id: m.senderId})
        MATCH (c:Conversation {id: m.conversationId})
        RETURN m {
          .id, .content, .conversationId, .senderId, .createdAt,
          sender: sender { .id, .name, .email, .isBot },
          conversationTitle: c.title,
          conversationType: c.type
        } AS message
        ORDER BY m.createdAt DESC
        LIMIT $limit
      `, { userId, q, limit: neo4j.int(limit) }),

      runQ(`
        MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
        WHERE c.title IS NOT NULL
          AND toLower(c.title) CONTAINS toLower($q)
        CALL {
          WITH c
          MATCH (participant:User)-[:PARTICIPATES_IN]->(c)
          RETURN collect(participant { .id, .name, .email, .isBot })[0..3] AS participants
        }
        RETURN c {
          .id, .title, .type, .lastMessageAt, .lastMessagePreview,
          participants: participants
        } AS conversation
        ORDER BY c.lastMessageAt DESC
        LIMIT $limit
      `, { userId, q, limit: neo4j.int(limit) }),

      // Contacts: case-insensitive CONTAINS on name OR email.
      // OpenChat-search-self: includes SELF when the literal query matches the
      // user's own name/email OR when the query is a reserved self-keyword
      // ('me', 'self', 'myself'). Codex review 2026-06-01: dropping the
      // u.id <> $userId exclusion does not leak — the response shape only
      // contains data the user already has on their own profile.
      runQ(`
        MATCH (u:User)
        WHERE (toLower(u.name) CONTAINS toLower($q) OR toLower(u.email) CONTAINS toLower($q))
           OR (u.id = $userId AND toLower($q) IN ['me', 'self', 'myself'])
        RETURN u { .id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot } AS user
        ORDER BY CASE WHEN u.id = $userId THEN 0 ELSE 1 END, u.name
        LIMIT $limit
      `, { userId, q, limit: neo4j.int(limit) }),
    ]);

    const keywordMessages = messagesResult.records.map(r => toJS(r.get('message')));
    const conversations = conversationsResult.records.map(r => toJS(r.get('conversation')));
    const contacts = contactsResult.records.map(r => toJS(r.get('user')));

    // For semantic/hybrid mode use the vector results when available; for
    // 'hybrid' specifically, fold in any keyword matches the vector search
    // missed (dedupe by conversationId+content), capped at `limit`.
    let messages = keywordMessages;
    if (semanticMessages) {
      if (mode === 'hybrid') {
        const seen = new Set<string>();
        const merged: unknown[] = [];
        for (const m of semanticMessages) {
          const mm = m as { conversationId?: string; content?: string };
          seen.add(`${mm.conversationId}::${mm.content}`);
          merged.push(m);
        }
        for (const m of keywordMessages) {
          const mm = m as { conversationId?: string; content?: string };
          const key = `${mm.conversationId}::${mm.content}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(m);
        }
        messages = merged.slice(0, limit);
      } else {
        messages = semanticMessages;
      }
    }

    res.json({ messages, conversations, contacts });
  } catch (error) {
    console.error('Error performing search:', error);
    res.status(500).json({ error: 'Search failed' });
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
      RETURN u { .id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot } AS user
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

// ─── Block / unblock (OpenChat-46p) ─────────────────────────────────────────

// POST /api/chat/users/:id/block
router.post('/users/:id/block', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const myId = req.user!.userId;
  const targetId = req.params.id as string;

  if (myId === targetId) {
    res.status(400).json({ error: 'Cannot block yourself' });
    return;
  }

  try {
    const now = new Date().toISOString();
    await session.run(`
      MATCH (me:User {id: $myId}), (target:User {id: $targetId})
      MERGE (me)-[r:BLOCKED]->(target)
      ON CREATE SET r.createdAt = datetime($now)
    `, { myId, targetId, now });
    res.status(201).json({ blocked: true, targetId });
  } catch (error) {
    console.error('Error blocking user:', error);
    res.status(500).json({ error: 'Failed to block user' });
  } finally {
    await session.close();
  }
});

// DELETE /api/chat/users/:id/block
router.delete('/users/:id/block', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const myId = req.user!.userId;
  const targetId = req.params.id as string;

  try {
    await session.run(`
      MATCH (me:User {id: $myId})-[r:BLOCKED]->(target:User {id: $targetId})
      DELETE r
    `, { myId, targetId });
    res.status(200).json({ blocked: false, targetId });
  } catch (error) {
    console.error('Error unblocking user:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/blocks — returns list of users I have blocked
router.get('/blocks', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const myId = req.user!.userId;

  try {
    const result = await session.run(`
      MATCH (me:User {id: $myId})-[r:BLOCKED]->(target:User)
      RETURN target { .id, .name, .email, .presenceStatus, .isBot } AS user, r.createdAt AS blockedAt
      ORDER BY r.createdAt DESC
    `, { myId });
    const blocks = result.records.map(r => ({
      user: toJS(r.get('user')),
      blockedAt: toJS(r.get('blockedAt')),
    }));
    res.json(blocks);
  } catch (error) {
    console.error('Error fetching blocks:', error);
    res.status(500).json({ error: 'Failed to fetch blocks' });
  } finally {
    await session.close();
  }
});

// ─── Forward message (OpenChat-hhc) ──────────────────────────────────────────

// POST /api/chat/messages/:id/forward
// Body: { toConversationId: string }
// Creates a new Message in the target conversation, copying content/attachments
// from the source and preserving the original sender via forwardedFrom* fields.
// The forward chain always points to the ORIGINAL sender (not the most recent
// forwarder), so forwarding a forwarded message keeps Alice's name visible.
router.post('/messages/:id/forward', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const sourceMessageId = req.params.id as string;
  const { toConversationId } = (req.body ?? {}) as { toConversationId?: string };

  if (!toConversationId || typeof toConversationId !== 'string') {
    res.status(400).json({ error: 'toConversationId is required' });
    return;
  }

  try {
    // 1. Load source message and verify caller is a participant in its conversation.
    const sourceResult = await session.run(`
      MATCH (m:Message {id: $sourceMessageId})
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: m.conversationId})
      MATCH (originalSender:User {id: m.senderId})
      RETURN m {
        .id, .content, .attachments, .conversationId,
        .forwardedFromMessageId, .forwardedFromSenderId, .forwardedFromSenderName
      } AS msg,
      originalSender { .id, .name, .email } AS sender
    `, { sourceMessageId, userId });

    if (sourceResult.records.length === 0) {
      res.status(404).json({ error: 'Message not found or not accessible' });
      return;
    }

    const sourceMsg = toJS(sourceResult.records[0].get('msg')) as Record<string, unknown>;
    const originalSender = toJS(sourceResult.records[0].get('sender')) as Record<string, string | undefined>;

    // 2. Verify caller participates in the target conversation.
    const targetCheck = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $toConversationId})
      RETURN c
    `, { userId, toConversationId });

    if (targetCheck.records.length === 0) {
      res.status(404).json({ error: 'Target conversation not found or not accessible' });
      return;
    }

    // 3. Resolve forwardedFrom* fields.
    // If the source was already a forward, propagate ITS original sender (not
    // the current sender). This keeps the forward chain pointing to Alice even
    // if Bob forwarded Alice's message and Carol then forwards Bob's forward.
    const forwardedFromMessageId = (sourceMsg.forwardedFromMessageId as string | null) ?? sourceMessageId;
    const forwardedFromSenderId = (sourceMsg.forwardedFromSenderId as string | null) ?? (originalSender.id as string);
    // Snapshot the display name at forward time from the current DB value.
    const forwardedFromSenderName =
      (sourceMsg.forwardedFromSenderName as string | null) ??
      (originalSender.name as string | null) ??
      (originalSender.email as string | null) ??
      'Unknown';

    // 4. Copy attachments (still references the same S3 objects — no re-upload).
    const attachmentsRaw = sourceMsg.attachments;
    let attachmentsJson: string | null = null;
    if (typeof attachmentsRaw === 'string' && attachmentsRaw) {
      attachmentsJson = attachmentsRaw; // already JSON string in DB
    } else if (Array.isArray(attachmentsRaw) && attachmentsRaw.length > 0) {
      attachmentsJson = JSON.stringify(attachmentsRaw);
    }

    const messageId = nanoid();
    const now = new Date().toISOString();
    const content = (sourceMsg.content as string) || '';
    const preview = content || (attachmentsJson ? '📷 Photo' : '');

    // 5. Create the new message in the target conversation.
    const result = await session.run(`
      MATCH (c:Conversation {id: $toConversationId})
      MATCH (forwarder:User {id: $userId})
      CREATE (m:Message {
        id: $id,
        content: $content,
        senderId: $userId,
        conversationId: $toConversationId,
        messageType: 'text',
        createdAt: datetime($now),
        attachments: $attachmentsJson,
        forwardedFromMessageId: $forwardedFromMessageId,
        forwardedFromSenderId: $forwardedFromSenderId,
        forwardedFromSenderName: $forwardedFromSenderName
      })
      CREATE (m)-[:IN_CONVERSATION]->(c)
      CREATE (forwarder)-[:SENT]->(m)
      SET c.updatedAt = datetime($now),
          c.lastMessageAt = datetime($now),
          c.lastMessagePreview = left($preview, 100)
      WITH c, m, forwarder
      MATCH (p:User)-[:PARTICIPATES_IN]->(c)
      RETURN m { .*, sender: forwarder { .id, .name, .email } } AS message,
             collect(DISTINCT p.id) AS participantIds
    `, {
      id: messageId,
      content,
      userId,
      toConversationId,
      now,
      attachmentsJson,
      forwardedFromMessageId,
      forwardedFromSenderId,
      forwardedFromSenderName,
      preview,
    });

    const raw = toJS(result.records[0].get('message')) as Record<string, unknown>;
    const participantIds = result.records[0].get('participantIds') as string[];
    // Parse attachments JSON string back to array for the response.
    if (raw && typeof raw.attachments === 'string') {
      try { raw.attachments = JSON.parse(raw.attachments as string); } catch { /* leave */ }
    }

    // 6. Emit message:new to target conversation room.
    const io = req.app.get('io') as IOServer | undefined;
    if (io) {
      io.to(`conversation:${toConversationId}`).emit('message:new', raw);
    }
    dispatchMessageEvent(raw, participantIds);

    res.status(201).json(raw);
  } catch (error) {
    console.error('Error forwarding message:', error);
    res.status(500).json({ error: 'Failed to forward message' });
  } finally {
    await session.close();
  }
});

// ─── Reports (OpenChat-wgl) ──────────────────────────────────────────────────

// POST /api/chat/reports
router.post('/reports', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const reporterId = req.user!.userId;
  const { targetType, targetId, reason, freeform } = (req.body ?? {}) as {
    targetType?: string;
    targetId?: string;
    reason?: string;
    freeform?: string;
  };

  if (!targetType || !['message', 'user'].includes(targetType)) {
    res.status(400).json({ error: 'targetType must be "message" or "user"' });
    return;
  }
  if (!targetId || typeof targetId !== 'string') {
    res.status(400).json({ error: 'targetId is required' });
    return;
  }

  try {
    const now = new Date().toISOString();
    const reportId = nanoid();

    await session.run(`
      CREATE (r:Report {
        id: $id,
        reporterId: $reporterId,
        targetType: $targetType,
        targetId: $targetId,
        reason: $reason,
        freeform: $freeform,
        createdAt: datetime($now),
        status: 'open'
      })
    `, {
      id: reportId,
      reporterId,
      targetType,
      targetId,
      reason: reason ?? null,
      freeform: freeform ?? null,
      now,
    });

    // Post to Slack webhook if configured — fire-and-forget, never error the caller.
    const webhookUrl = process.env.REPORT_SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      const payload = {
        text: `*New ${targetType} report* (id: ${reportId})`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*New ${targetType} report*\nReporter: \`${reporterId}\`\nTarget: \`${targetId}\`\nReason: ${reason ?? '—'}\nFreeform: ${freeform ?? '—'}`,
            },
          },
        ],
      };
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((err) => {
        console.warn('[reports] Slack webhook failed:', err);
      });
    } else {
      console.log(`[reports] New report ${reportId}: ${targetType} ${targetId} by ${reporterId}`);
    }

    res.status(201).json({ id: reportId });
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ error: 'Failed to create report' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/reports/mine — user's own past reports
router.get('/reports/mine', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const reporterId = req.user!.userId;

  try {
    const result = await session.run(`
      MATCH (r:Report {reporterId: $reporterId})
      RETURN r { .id, .targetType, .targetId, .reason, .freeform, .createdAt, .status } AS report
      ORDER BY r.createdAt DESC
    `, { reporterId });
    const reports = result.records.map(r => toJS(r.get('report')));
    res.json(reports);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  } finally {
    await session.close();
  }
});

// ─── AI disclosure (OpenChat-ds3) ────────────────────────────────────────────

// GET /api/chat/ai-disclosure-status
router.get('/ai-disclosure-status', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})
      RETURN u.aiDisclosureAcceptedAt AS acceptedAt
    `, { userId });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const raw = result.records[0].get('acceptedAt');
    const acceptedAt = raw ? toJS(raw) : null;
    res.json({ acceptedAt });
  } catch (error) {
    console.error('Error fetching AI disclosure status:', error);
    res.status(500).json({ error: 'Failed to fetch disclosure status' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/ai-disclosure-accept
router.post('/ai-disclosure-accept', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const now = new Date().toISOString();
    await session.run(`
      MATCH (u:User {id: $userId})
      SET u.aiDisclosureAcceptedAt = datetime($now)
    `, { userId, now });
    res.json({ acceptedAt: now });
  } catch (error) {
    console.error('Error accepting AI disclosure:', error);
    res.status(500).json({ error: 'Failed to accept disclosure' });
  } finally {
    await session.close();
  }
});

// ─── Edit / Delete messages (OpenChat-q9h) ───────────────────────────────────

// Helper: load participant IDs of a conversation for socket fanout.
async function loadParticipantIds(
  session: ReturnType<ReturnType<typeof getDriver>['session']>,
  conversationId: string
): Promise<string[]> {
  const result = await session.run(`
    MATCH (u:User)-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
    RETURN u.id AS uid
  `, { conversationId });
  return result.records.map(r => r.get('uid') as string);
}

// Emit message:updated to all participants of a conversation.
function emitMessageUpdated(
  io: IOServer | undefined,
  conversationId: string,
  participantIds: string[],
  message: unknown
): void {
  if (!io) return;
  // Emit to the conversation room (sockets already joined).
  io.to(`conversation:${conversationId}`).emit('message:updated', message);
  // Also emit to per-user rooms so participants who aren't in the room get it.
  for (const uid of participantIds) {
    io.to(`user:${uid}`).emit('message:updated', message);
  }
}

// Emit message:reactions-updated to all participants.
function emitReactionsUpdated(
  io: IOServer | undefined,
  conversationId: string,
  participantIds: string[],
  payload: unknown
): void {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit('message:reactions-updated', payload);
  for (const uid of participantIds) {
    io.to(`user:${uid}`).emit('message:reactions-updated', payload);
  }
}

// PATCH /api/chat/messages/:id — edit own message (owner-only)
router.patch('/messages/:id', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const messageId = req.params.id as string;
  const { content } = req.body as { content?: string };

  if (!content || typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  try {
    // Verify ownership and get conversationId
    const check = await session.run(`
      MATCH (m:Message {id: $messageId})
      WHERE m.senderId = $userId AND m.deletedAt IS NULL
      RETURN m.conversationId AS conversationId
    `, { messageId, userId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Message not found or not yours' });
      return;
    }

    const conversationId = check.records[0].get('conversationId') as string;
    const now = new Date().toISOString();

    const result = await session.run(`
      MATCH (m:Message {id: $messageId})
      MATCH (sender:User {id: m.senderId})
      SET m.content = $content, m.editedAt = datetime($now)
      RETURN m { .*, sender: sender { .id, .name, .email } } AS message
    `, { messageId, content: content.trim(), now });

    const message = toJS(result.records[0].get('message'));

    // Broadcast to all conversation participants
    const io = req.app.get('io') as IOServer | undefined;
    const participantIds = await loadParticipantIds(session, conversationId);
    emitMessageUpdated(io, conversationId, participantIds, message);

    res.json(message);
  } catch (error) {
    console.error('Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  } finally {
    await session.close();
  }
});

// DELETE /api/chat/messages/:id — soft-delete own message (owner-only)
router.delete('/messages/:id', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const messageId = req.params.id as string;

  try {
    // Verify ownership
    const check = await session.run(`
      MATCH (m:Message {id: $messageId})
      WHERE m.senderId = $userId
      RETURN m.conversationId AS conversationId
    `, { messageId, userId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Message not found or not yours' });
      return;
    }

    const conversationId = check.records[0].get('conversationId') as string;
    const now = new Date().toISOString();

    const result = await session.run(`
      MATCH (m:Message {id: $messageId})
      MATCH (sender:User {id: m.senderId})
      SET m.content = 'Message deleted',
          m.deletedAt = datetime($now),
          m.attachments = null
      RETURN m { .*, sender: sender { .id, .name, .email } } AS message
    `, { messageId, now });

    const message = toJS(result.records[0].get('message'));

    const io = req.app.get('io') as IOServer | undefined;
    const participantIds = await loadParticipantIds(session, conversationId);
    emitMessageUpdated(io, conversationId, participantIds, message);

    res.json(message);
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  } finally {
    await session.close();
  }
});

// ─── Reactions (OpenChat-7bd) ─────────────────────────────────────────────────

// Reaction kinds (openchat-reaction-kind). A "kind" tags a reaction with
// semantic meaning beyond the raw emoji. 'filed' is the first kind: a bot's
// filed-receipt whose `href` links to the knowledge-base page it created.
// Plain reactions have no kind (kind = null) and stay fully backward compatible.
const ALLOWED_KINDS = ['filed'];

// Helper: aggregate reactions on a message for the requesting user.
// Kind reactions (kind != null) carry an optional `href` and are grouped
// separately from plain reactions with the same emoji so clients can render
// them distinctly (e.g. a tappable filed badge).
async function getReactionSummary(
  session: ReturnType<ReturnType<typeof getDriver>['session']>,
  messageId: string,
  userId: string
): Promise<Array<{ emoji: string; count: number; byMe: boolean; kind?: string; href?: string }>> {
  const result = await session.run(`
    MATCH (u:User)-[r:REACTED]->(m:Message {id: $messageId})
    WITH r.emoji AS emoji, r.kind AS kind, r.href AS href, count(*) AS cnt, collect(u.id) AS reactors
    RETURN emoji, kind, href, cnt, $userId IN reactors AS byMe
    ORDER BY kind, emoji
  `, { messageId, userId });
  return result.records.map(rec => {
    const kind = rec.get('kind') as string | null;
    const href = rec.get('href') as string | null;
    return {
      emoji: rec.get('emoji') as string,
      count: (rec.get('cnt') as { toNumber: () => number }).toNumber?.() ?? Number(rec.get('cnt')),
      byMe: rec.get('byMe') as boolean,
      ...(kind ? { kind } : {}),
      ...(href ? { href } : {}),
    };
  });
}

// POST /api/chat/messages/:id/reactions — add reaction (idempotent)
// Uses resolveActor (not requireAuth) so agent-key (oc_) callers — e.g. a bot
// filing a KB receipt — may react, not just JWT-authenticated humans
// (openchat-reaction-kind).
router.post('/messages/:id/reactions', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const messageId = req.params.id as string;
  const { emoji, kind, href } = req.body as { emoji?: string; kind?: string; href?: string };

  // Emoji allowlist for plain human reactions. Kind reactions (e.g. a filed
  // receipt) may use a filing glyph outside this set.
  const ALLOWED_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const ALLOWED_KIND_EMOJI = ['🗂️', '📁', '📎', '✅'];

  // Validate kind first: only allowlisted kinds are accepted.
  if (kind !== undefined && kind !== null) {
    if (!ALLOWED_KINDS.includes(kind)) {
      res.status(400).json({ error: `kind must be one of: ${ALLOWED_KINDS.join(', ')}` });
      return;
    }
    // 'filed' receipts must link to the page they created.
    if (kind === 'filed') {
      if (!href || !/^https?:\/\/.+/i.test(href)) {
        res.status(400).json({ error: "kind 'filed' requires an http(s) href" });
        return;
      }
    }
  }

  const isKindReaction = kind !== undefined && kind !== null;
  const emojiAllowed = isKindReaction
    ? ALLOWED_KIND_EMOJI.includes(emoji ?? '')
    : ALLOWED_EMOJI.includes(emoji ?? '');
  if (!emoji || !emojiAllowed) {
    const list = isKindReaction ? ALLOWED_KIND_EMOJI : ALLOWED_EMOJI;
    res.status(400).json({ error: `emoji must be one of: ${list.join(' ')}` });
    return;
  }

  try {
    // Verify user is participant in the conversation containing this message
    const check = await session.run(`
      MATCH (m:Message {id: $messageId})
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: m.conversationId})
      RETURN m.conversationId AS conversationId
    `, { messageId, userId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Message not found or not accessible' });
      return;
    }

    const conversationId = check.records[0].get('conversationId') as string;
    const now = new Date().toISOString();

    if (isKindReaction) {
      await session.run(`
        MATCH (u:User {id: $userId}), (m:Message {id: $messageId})
        MERGE (u)-[r:REACTED {emoji: $emoji, kind: $kind}]->(m)
        ON CREATE SET r.createdAt = datetime($now)
        SET r.href = $href
      `, { userId, messageId, emoji, now, kind, href: href ?? null });
    } else {
      await session.run(`
        MATCH (u:User {id: $userId}), (m:Message {id: $messageId})
        OPTIONAL MATCH (u)-[existing:REACTED {emoji: $emoji}]->(m)
        WHERE existing.kind IS NULL
        WITH u, m, existing
        FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
          CREATE (u)-[:REACTED {emoji: $emoji, createdAt: datetime($now)}]->(m)
        )
      `, { userId, messageId, emoji, now });
    }

    const reactions = await getReactionSummary(session, messageId, userId);

    const io = req.app.get('io') as IOServer | undefined;
    const participantIds = await loadParticipantIds(session, conversationId);
    const payload = { messageId, conversationId, reactions };
    emitReactionsUpdated(io, conversationId, participantIds, payload);

    res.status(201).json({ reactions });
  } catch (error) {
    console.error('Error adding reaction:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  } finally {
    await session.close();
  }
});

// DELETE /api/chat/messages/:id/reactions/:emoji — remove own reaction.
// Optional ?kind= query param removes a kind edge (e.g. a filed receipt);
// omitting it removes the plain (kind-less) reaction. Uses resolveActor so
// agent-key callers can remove their own reactions too (openchat-reaction-kind).
router.delete('/messages/:id/reactions/:emoji', resolveActor, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const messageId = req.params.id as string;
  const emoji = decodeURIComponent(req.params.emoji as string);
  const kindParam = req.query.kind;
  const kind = typeof kindParam === 'string' && kindParam.length > 0 ? kindParam : null;

  try {
    // Verify access
    const check = await session.run(`
      MATCH (m:Message {id: $messageId})
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: m.conversationId})
      RETURN m.conversationId AS conversationId
    `, { messageId, userId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Message not found or not accessible' });
      return;
    }

    const conversationId = check.records[0].get('conversationId') as string;

    // Match on kind too: null kind removes only the plain reaction; a supplied
    // kind removes that specific kind edge, leaving any plain reaction intact.
    await session.run(`
      MATCH (u:User {id: $userId})-[r:REACTED {emoji: $emoji}]->(m:Message {id: $messageId})
      WHERE r.kind = $kind OR (r.kind IS NULL AND $kind IS NULL)
      DELETE r
    `, { userId, messageId, emoji, kind });

    const reactions = await getReactionSummary(session, messageId, userId);

    const io = req.app.get('io') as IOServer | undefined;
    const participantIds = await loadParticipantIds(session, conversationId);
    const payload = { messageId, conversationId, reactions };
    emitReactionsUpdated(io, conversationId, participantIds, payload);

    res.json({ reactions });
  } catch (error) {
    console.error('Error removing reaction:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  } finally {
    await session.close();
  }
});

// ─── Attachments (OpenChat-6bg) ──────────────────────────────────────────────

// Image MIME types allowed for upload (OpenChat-6bg).
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Audio MIME types allowed for voice messages (OpenChat-xxc).
const AUDIO_MIME_TYPES = new Set([
  'audio/m4a',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-m4a',
  'audio/webm',
]);

const ALLOWED_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, ...AUDIO_MIME_TYPES]);

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;  // 20 MB for images
const MAX_AUDIO_SIZE_BYTES = 10 * 1024 * 1024;  // 10 MB for audio

// POST /api/chat/attachments/presign
// Body: { filename: string, mimeType: string, sizeBytes: number }
// Returns: { putUrl, getUrl, key }
router.post('/attachments/presign', requireAuth, async (req: Request, res: Response) => {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    res.status(503).json({ error: 'File uploads are not configured on this server' });
    return;
  }

  const { filename, mimeType, sizeBytes } = req.body as {
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
  };

  if (!filename || typeof filename !== 'string') {
    res.status(400).json({ error: 'filename is required' });
    return;
  }
  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
    res.status(400).json({
      error: `mimeType must be one of: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
    });
    return;
  }

  const maxSize = AUDIO_MIME_TYPES.has(mimeType)
    ? MAX_AUDIO_SIZE_BYTES
    : MAX_IMAGE_SIZE_BYTES;

  if (typeof sizeBytes !== 'number' || sizeBytes <= 0 || sizeBytes > maxSize) {
    res.status(400).json({ error: `sizeBytes must be between 1 and ${maxSize}` });
    return;
  }

  // Build a storage key: attachments/<userId>/<nanoid>/<sanitised filename>
  // For audio, standardise the extension so GCS serves the correct Content-Type.
  const userId = req.user!.userId;
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  const audioSuffix = AUDIO_MIME_TYPES.has(mimeType) ? 'voice.m4a' : safeFilename;
  const key = `attachments/${userId}/${nanoid()}/${AUDIO_MIME_TYPES.has(mimeType) ? audioSuffix : safeFilename}`;

  try {
    const s3 = getS3();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: sizeBytes,
    });
    const putUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes

    // Public GET URL (bucket is public-read)
    const endpoint = process.env.S3_ENDPOINT || 'https://storage.googleapis.com';
    const getUrl = `${endpoint}/${bucket}/${key}`;

    res.json({ putUrl, getUrl, key });
  } catch (err) {
    console.error('[attachments] presign error:', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ─── Reconnect catch-up (OpenChat-qz0) ──────────────────────────────────────
//
// GET /api/chat/messages/since?since=<ISO>&limit=500
//
// Returns all messages across every conversation the requester participates in
// where createdAt > since, ordered chronologically. Used by the mobile app to
// recover missed messages after a socket reconnect.
//
// Hard cap at 500 messages. Anything beyond that is unusual — if we hit the
// cap we log a warning server-side so the operator knows a client has a large
// gap. The client should fall back to a full refreshConversations() when the
// cap is hit (the response includes a `truncated: true` flag).
//
// NOTE: No message retention window is enforced today. If one is added in the
// future, callers whose `since` pre-dates it should receive the oldest
// available messages (i.e. NOT an error) and a `retention_truncated: true`
// flag so the client knows a full re-fetch is advisable.
//
// Uses the message_createdAt range index (see migration comment below).
// If the index doesn't exist yet the query will still work via a full scan,
// just more slowly. The index is created idempotently at server startup via
// db.ts — see ensureMessageCreatedAtIndex() below — or can be run manually:
//   CREATE RANGE INDEX message_createdAt FOR (m:Message) ON (m.createdAt)
router.get('/messages/since', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const sinceRaw = req.query.since as string | undefined;

  if (!sinceRaw || typeof sinceRaw !== 'string') {
    res.status(400).json({ error: 'since (ISO timestamp) is required' });
    return;
  }

  // Validate it's a parseable ISO date.
  const sinceDate = new Date(sinceRaw);
  if (isNaN(sinceDate.getTime())) {
    res.status(400).json({ error: 'since must be a valid ISO timestamp' });
    return;
  }

  const HARD_CAP = 500;

  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)<-[:IN_CONVERSATION]-(m:Message)
      WHERE m.createdAt > datetime($since)
        AND m.deletedAt IS NULL
      MATCH (sender:User {id: m.senderId})
      CALL {
        WITH m
        OPTIONAL MATCH (reactor:User)-[r:REACTED]->(m)
        WITH r.emoji AS emoji, r.kind AS kind, r.href AS href, count(*) AS cnt, collect(reactor.id) AS reactors
        WHERE emoji IS NOT NULL
        RETURN collect({ emoji: emoji, count: cnt, byMe: $userId IN reactors, kind: kind, href: href }) AS reactions
      }
      RETURN m { .*, sender: sender { .id, .name, .email }, reactions: reactions } AS message
      ORDER BY m.createdAt ASC
      LIMIT $cap
    `, {
      userId,
      since: sinceRaw,
      cap: neo4j.int(HARD_CAP + 1), // fetch one extra to detect truncation
    });

    const rawMessages = result.records.map(r => {
      const msg = toJS(r.get('message')) as Record<string, unknown>;
      if (msg && typeof msg.attachments === 'string') {
        try { msg.attachments = JSON.parse(msg.attachments as string); } catch { /* leave as string */ }
      }
      return msg;
    });

    const truncated = rawMessages.length > HARD_CAP;
    const messages = truncated ? rawMessages.slice(0, HARD_CAP) : rawMessages;

    if (truncated) {
      console.warn(`[messages/since] userId=${userId} hit the ${HARD_CAP}-message cap (since=${sinceRaw}). Client should do a full refresh.`);
    }

    res.json({ messages, truncated });
  } catch (error) {
    console.error('Error fetching messages since:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  } finally {
    await session.close();
  }
});

// ── Group Invite Routes (OpenChat-240) ──────────────────────────────────────

// POST /api/chat/conversations/:id/invites — owner-only, create or return active invite
router.post('/conversations/:id/invites', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const convId = req.params.id as string;
  const { expiresInDays = 7, maxUses = 50 } = req.body as { expiresInDays?: number; maxUses?: number };

  try {
    // Verify caller is owner of a group
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $convId})
      RETURN c.type AS type, rel.role AS role
    `, { userId, convId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const role = check.records[0].get('role');
    const type = check.records[0].get('type');
    if (type !== 'group') {
      res.status(400).json({ error: 'Invites are only for group conversations' });
      return;
    }
    if (role !== 'owner') {
      res.status(403).json({ error: 'Only the group owner can create invites' });
      return;
    }

    // Check for an existing active non-expired invite from this owner
    const existing = await session.run(`
      MATCH (c:Conversation {id: $convId})-[:HAS_INVITE]->(inv:GroupInvite {createdBy: $userId})
      WHERE inv.revokedAt IS NULL
        AND datetime(inv.expiresAt) > datetime()
        AND inv.usesLeft > 0
      RETURN inv
      ORDER BY inv.createdAt DESC
      LIMIT 1
    `, { convId, userId });

    if (existing.records.length > 0) {
      const inv = toJS(existing.records[0].get('inv').properties) as Record<string, unknown>;
      const token = inv.token as string;
      res.json({
        token,
        url: `https://chat.globalbr.ai/i/${token}`,
        expiresAt: inv.expiresAt,
        usesLeft: inv.usesLeft,
      });
      return;
    }

    // Create new invite
    const token = nanoid(32);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    await session.run(`
      MATCH (c:Conversation {id: $convId})
      CREATE (inv:GroupInvite {
        token: $token,
        conversationId: $convId,
        createdBy: $userId,
        createdAt: datetime($now),
        expiresAt: datetime($expiresAt),
        usesLeft: $maxUses
      })
      CREATE (c)-[:HAS_INVITE]->(inv)
    `, { convId, token, userId, now, expiresAt, maxUses: neo4j.int(maxUses) });

    res.status(201).json({
      token,
      url: `https://chat.globalbr.ai/i/${token}`,
      expiresAt,
      usesLeft: maxUses,
    });
  } catch (error) {
    console.error('Error creating invite:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/conversations/:id/invites — owner-only, list active invites
router.get('/conversations/:id/invites', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const convId = req.params.id as string;

  try {
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $convId})
      RETURN rel.role AS role
    `, { userId, convId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (check.records[0].get('role') !== 'owner') {
      res.status(403).json({ error: 'Only the group owner can list invites' });
      return;
    }

    const result = await session.run(`
      MATCH (c:Conversation {id: $convId})-[:HAS_INVITE]->(inv:GroupInvite)
      WHERE inv.revokedAt IS NULL AND datetime(inv.expiresAt) > datetime()
      RETURN inv
      ORDER BY inv.createdAt DESC
    `, { convId });

    const invites = result.records.map(r => {
      const props = toJS(r.get('inv').properties) as Record<string, unknown>;
      return {
        token: props.token,
        url: `https://chat.globalbr.ai/i/${props.token}`,
        expiresAt: props.expiresAt,
        usesLeft: props.usesLeft,
        createdAt: props.createdAt,
      };
    });

    res.json(invites);
  } catch (error) {
    console.error('Error listing invites:', error);
    res.status(500).json({ error: 'Failed to list invites' });
  } finally {
    await session.close();
  }
});

// GET /api/chat/invites/:token — any authed user, preview invite
router.get('/invites/:token', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const token = req.params.token as string;

  try {
    const result = await session.run(`
      MATCH (c:Conversation)-[:HAS_INVITE]->(inv:GroupInvite {token: $token})
      RETURN inv, c.id AS conversationId, c.title AS conversationTitle
    `, { token });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    const rec = result.records[0];
    const inv = toJS(rec.get('inv').properties) as Record<string, unknown>;
    const conversationId = rec.get('conversationId') as string;
    const conversationTitle = rec.get('conversationTitle') as string | null;

    if (inv.revokedAt) {
      res.status(410).json({ error: 'This invite has been revoked' });
      return;
    }
    const usesLeft = typeof inv.usesLeft === 'object' && inv.usesLeft !== null && 'toNumber' in (inv.usesLeft as object)
      ? (inv.usesLeft as { toNumber: () => number }).toNumber()
      : (inv.usesLeft as number);
    if (usesLeft <= 0) {
      res.status(410).json({ error: 'This invite has reached its maximum uses' });
      return;
    }
    const expiresAt = inv.expiresAt as string;
    if (new Date(expiresAt) < new Date()) {
      res.status(410).json({ error: 'This invite has expired' });
      return;
    }

    // Get member count (no PII)
    const countResult = await session.run(`
      MATCH (:User)-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      RETURN count(*) AS memberCount
    `, { conversationId });
    const memberCount = countResult.records[0]?.get('memberCount')?.toNumber?.() ?? 0;

    res.json({
      conversationId,
      conversationTitle,
      memberCount,
      expiresAt,
    });
  } catch (error) {
    console.error('Error fetching invite:', error);
    res.status(500).json({ error: 'Failed to fetch invite' });
  } finally {
    await session.close();
  }
});

// POST /api/chat/invites/:token/accept — any authed user, join via invite
router.post('/invites/:token/accept', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const token = req.params.token as string;

  try {
    const result = await session.run(`
      MATCH (c:Conversation)-[:HAS_INVITE]->(inv:GroupInvite {token: $token})
      RETURN inv, c.id AS conversationId
    `, { token });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    const rec = result.records[0];
    const inv = toJS(rec.get('inv').properties) as Record<string, unknown>;
    const conversationId = rec.get('conversationId') as string;

    if (inv.revokedAt) {
      res.status(410).json({ error: 'This invite has been revoked' });
      return;
    }
    const usesLeft = typeof inv.usesLeft === 'object' && inv.usesLeft !== null && 'toNumber' in (inv.usesLeft as object)
      ? (inv.usesLeft as { toNumber: () => number }).toNumber()
      : (inv.usesLeft as number);
    if (usesLeft <= 0) {
      res.status(410).json({ error: 'This invite has reached its maximum uses' });
      return;
    }
    const expiresAt = inv.expiresAt as string;
    if (new Date(expiresAt) < new Date()) {
      res.status(410).json({ error: 'This invite has expired' });
      return;
    }

    // Check if already a participant — idempotent
    const alreadyIn = await session.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      RETURN c
    `, { userId, conversationId });

    const now = new Date().toISOString();

    if (alreadyIn.records.length === 0) {
      // Add the user (MERGE so it's safe if there's a race)
      await session.run(`
        MATCH (c:Conversation {id: $conversationId})
        MATCH (u:User {id: $userId})
        MERGE (u)-[rel:PARTICIPATES_IN]->(c)
          ON CREATE SET rel.joinedAt = datetime($now), rel.role = 'member'
        SET c.updatedAt = datetime($now)
      `, { conversationId, userId, now });

      // Decrement usesLeft on the invite
      await session.run(`
        MATCH (inv:GroupInvite {token: $token})
        SET inv.usesLeft = inv.usesLeft - 1
      `, { token });
    }

    // Load full conversation and emit participant:added
    const conversation = await loadConversation(session, conversationId);
    const io = req.app.get('io') as IOServer | undefined;
    if (io && conversation && alreadyIn.records.length === 0) {
      joinUserSocketsToConversation(io, userId, conversationId);
      const participants = (conversation.participants as Array<{ user?: { id?: string } }>) || [];
      const seen = new Set<string>();
      for (const p of participants) {
        const pid = p?.user?.id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        io.to(`user:${pid}`).emit('participant:added', {
          conversationId,
          conversation,
          userId,
        });
      }
    }

    res.json({ conversationId, conversation });
  } catch (error) {
    console.error('Error accepting invite:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  } finally {
    await session.close();
  }
});

// DELETE /api/chat/conversations/:id/invites/:token — owner-only, revoke invite
router.delete('/conversations/:id/invites/:token', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const convId = req.params.id as string;
  const token = req.params.token as string;

  try {
    const check = await session.run(`
      MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $convId})
      RETURN rel.role AS role
    `, { userId, convId });

    if (check.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (check.records[0].get('role') !== 'owner') {
      res.status(403).json({ error: 'Only the group owner can revoke invites' });
      return;
    }

    const result = await session.run(`
      MATCH (c:Conversation {id: $convId})-[:HAS_INVITE]->(inv:GroupInvite {token: $token})
      SET inv.revokedAt = datetime($now)
      RETURN inv
    `, { convId, token, now: new Date().toISOString() });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error revoking invite:', error);
    res.status(500).json({ error: 'Failed to revoke invite' });
  } finally {
    await session.close();
  }
});

export default router;
