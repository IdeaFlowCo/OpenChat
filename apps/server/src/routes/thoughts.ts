/**
 * Thoughts Stream API — personal notes feed (OpenChat-zi1)
 *
 * :Thought { id, userId, text, kind, status, createdAt, updatedAt }
 * kind:   'fact' | 'decision' | 'commitment' | 'reminder' | 'observation'
 * status: 'none' | 'open' | 'closed'
 *
 * All routes require auth. Users only modify their own Thoughts. The
 * conversation-scoped read also exposes inline-tag Thoughts to every current
 * participant of the source conversation, matching the source message's
 * visibility.
 */

import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import neo4j from 'neo4j-driver';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_KINDS = new Set(['fact', 'decision', 'commitment', 'reminder', 'observation']);
const VALID_STATUSES = new Set(['none', 'open', 'closed']);
const MAX_TEXT_LENGTH = 4000;
const MAX_TAG_SUGGESTIONS = 12;

// Helper to convert Neo4j types to plain JS values
function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (
    typeof value === 'object' &&
    'toString' in (value as object) &&
    'year' in (value as object)
  ) {
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

/**
 * Legacy dedupe (OpenChat-kb7f): before the write-side fix, a message with N
 * hashtags fanned out into N :Thought nodes sharing the same source message
 * and full message text. Merge any such rows into one — union their tags,
 * keep the earliest row's id/kind/createdAt — so old duplicates render once.
 * Rows without a sourceMessageId (or with no duplicates) pass through
 * untouched. Rows are expected newest-first, so for a given key the
 * earliest duplicate is the LAST one encountered.
 */
export function mergeDuplicateThoughtsFromSameMessage(
  thoughts: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const indexByKey = new Map<string, number>();
  const merged: Array<Record<string, unknown>> = [];

  for (const thought of thoughts) {
    const sourceMessageId = thought.sourceMessageId as string | null | undefined;
    const key = sourceMessageId ? `${sourceMessageId}::${thought.text as string}` : null;
    if (!key) {
      merged.push(thought);
      continue;
    }

    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({ ...thought, tags: [...((thought.tags as string[]) ?? [])] });
      continue;
    }

    const canonical = merged[idx] as Record<string, unknown> & { tags: string[] };
    for (const tag of (thought.tags as string[]) ?? []) {
      if (!canonical.tags.includes(tag)) canonical.tags.push(tag);
    }
    merged[idx] = {
      ...canonical,
      id: thought.id,
      kind: thought.kind,
      createdAt: thought.createdAt,
      updatedAt: thought.updatedAt,
    };
  }

  return merged;
}

/**
 * GET /api/thoughts/tags/suggestions?conversationId=<id>&q=<prefix>&limit=8
 *
 * Composer hashtag suggestions combine two deliberately bounded sources:
 *   - the caller's own previously-used tags (across all of their Thoughts)
 *   - tags other participants used in this conversation
 *
 * There is intentionally no global cross-user pool. The membership check and
 * the FROM_MESSAGE conversation constraint keep the shared half chat-scoped.
 */
router.get('/tags/suggestions', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = typeof req.query.conversationId === 'string'
    ? req.query.conversationId.trim()
    : '';
  const rawPrefix = typeof req.query.q === 'string' ? req.query.q.trim().replace(/^#/, '') : '';
  const prefix = rawPrefix.toLowerCase();
  const limit = Math.min(
    Math.max(parseInt(String(req.query.limit || '8'), 10) || 8, 1),
    MAX_TAG_SUGGESTIONS,
  );

  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }
  // Hashtag extraction currently accepts ASCII letters only. Rejecting an
  // incompatible prefix keeps this endpoint aligned with what sending stores.
  if (!/^[a-z]*$/i.test(prefix)) {
    res.status(400).json({ error: 'q must contain letters only' });
    return;
  }

  const session = getDriver().session();
  try {
    const partCheck = await session.run(
      `MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN c.id`,
      { userId, conversationId },
    );
    if (partCheck.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const result = await session.run(
      `
      MATCH (caller:User {id: $userId})
      MATCH (conversation:Conversation {id: $conversationId})
      CALL {
        WITH caller
        MATCH (caller)-[:HAS_THOUGHT]->(t:Thought)
        WHERE t.lane IS NULL OR t.lane <> 'context'
        UNWIND coalesce(t.tags, []) AS rawTag
        WITH toLower(rawTag) AS tag, t
        WHERE tag STARTS WITH $prefix AND tag <> ''
        RETURN tag, count(*) AS ownCount, max(t.createdAt) AS ownLastUsedAt,
               0 AS chatCount, null AS chatLastUsedAt

        UNION ALL

        WITH caller, conversation
        MATCH (author:User)-[:PARTICIPATES_IN]->(conversation)
        WHERE author.id <> caller.id
        MATCH (author)-[:HAS_THOUGHT]->(t:Thought)-[:FROM_MESSAGE]->(m:Message)
        WHERE (t.lane IS NULL OR t.lane <> 'context') AND m.conversationId = $conversationId
        UNWIND coalesce(t.tags, []) AS rawTag
        WITH toLower(rawTag) AS tag, t
        WHERE tag STARTS WITH $prefix AND tag <> ''
        RETURN tag, 0 AS ownCount, null AS ownLastUsedAt,
               count(*) AS chatCount, max(t.createdAt) AS chatLastUsedAt
      }
      WITH tag,
           sum(ownCount) AS ownCount,
           sum(chatCount) AS chatCount,
           max(ownLastUsedAt) AS ownLastUsedAt,
           max(chatLastUsedAt) AS chatLastUsedAt
      WITH tag, ownCount, chatCount,
           CASE
             WHEN ownLastUsedAt IS NULL THEN chatLastUsedAt
             WHEN chatLastUsedAt IS NULL THEN ownLastUsedAt
             WHEN ownLastUsedAt >= chatLastUsedAt THEN ownLastUsedAt
             ELSE chatLastUsedAt
           END AS lastUsedAt
      RETURN {
        tag: tag,
        source: CASE
          WHEN ownCount > 0 AND chatCount > 0 THEN 'both'
          WHEN ownCount > 0 THEN 'mine'
          ELSE 'chat'
        END,
        ownCount: ownCount,
        chatCount: chatCount,
        lastUsedAt: lastUsedAt
      } AS suggestion
      ORDER BY (ownCount + chatCount) DESC, lastUsedAt DESC, tag ASC
      LIMIT $limit
      `,
      { userId, conversationId, prefix, limit: neo4j.int(limit) },
    );

    res.json(result.records.map((record) => toJS(record.get('suggestion'))));
  } catch (err) {
    console.error('GET /api/thoughts/tags/suggestions error:', err);
    res.status(500).json({ error: 'Failed to fetch tag suggestions' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/thoughts?limit=50&before=<ISO createdAt>
 * List the current user's thoughts, newest first.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  // Search (?q=) — matches Thought text OR any of its tags (case-insensitive).
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;

  const conds: string[] = ['(t.lane IS NULL OR t.lane <> \'context\')'];
  if (before) conds.push('t.createdAt < datetime($before)');
  if (q)
    conds.push(
      '(toLower(t.text) CONTAINS toLower($q) OR any(tag IN coalesce(t.tags, []) WHERE toLower(tag) CONTAINS toLower($q)))'
    );
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought)
      ${where}
      // Provenance: which chat a tag-extracted thought came from, so the
      // Thoughts UI can label "from <chat>" + filter per-conversation.
      OPTIONAL MATCH (t)-[:FROM_MESSAGE]->(m:Message)
      OPTIONAL MATCH (conv:Conversation { id: m.conversationId })
      RETURN t {
        .id, .text, .kind, .status, .createdAt, .updatedAt,
        tags: coalesce(t.tags, []),
        sourceMessageId: m.id,
        sourceConversationId: m.conversationId,
        sourceConversationName: conv.name
      } AS thought
      ORDER BY t.createdAt DESC
      LIMIT $limit
      `,
      // Neo4j's LIMIT clause requires a true integer; JS Number(50) gets
      // serialized as 50.0 and Neo4j rejects it. Wrap via neo4j.int().
      // Same pattern as server/src/routes/chat.ts:796.
      { userId, before: before ?? undefined, q: q ?? undefined, limit: neo4j.int(limit) }
    );

    const thoughts = mergeDuplicateThoughtsFromSameMessage(
      result.records.map((r) => toJS(r.get('thought')) as Record<string, unknown>)
    );
    res.json(thoughts);
  } catch (err) {
    console.error('GET /api/thoughts error:', err);
    res.status(500).json({ error: 'Failed to fetch thoughts' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/thoughts/conversation/:conversationId
 * Chat-scoped Thoughts view (OpenChat-7nu follow-up / thoughts-design.md
 * "time-shifted contextual surfacing"). Requires the caller to be a
 * participant. Returns:
 *   pinned:   thoughts pinned to this conversation by ANY participant
 *             (pinning = sharing with the conversation, Plan B semantics)
 *   fromChat: the caller's private save-to-thoughts captures plus inline-tag
 *             thoughts created by ANY participant in this conversation
 */
router.get('/conversation/:conversationId', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { conversationId } = req.params;

  const session = getDriver().session();
  try {
    const partCheck = await session.run(
      `MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN c.id`,
      { userId, conversationId }
    );
    if (partCheck.records.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const pinnedResult = await session.run(
      `
      MATCH (t:Thought)-[p:PINNED_IN]->(c:Conversation {id: $conversationId})
      OPTIONAL MATCH (author:User {id: t.userId})
      RETURN t {
        .id, .text, .kind, .status, .createdAt, .updatedAt,
        tags: coalesce(t.tags, []),
        authorId: t.userId,
        authorName: author.name,
        pinnedBy: p.pinnedBy,
        pinnedAt: p.pinnedAt,
        pinned: true
      } AS thought
      ORDER BY p.pinnedAt DESC
      LIMIT 100
      `,
      { conversationId }
    );

    const fromChatResult = await session.run(
      `
      MATCH (t:Thought)-[:FROM_MESSAGE]->(m:Message {conversationId: $conversationId})
      // Manual save-to-thoughts captures remain owner-only unless pinned.
      // Inline-tag Thoughts follow source-message visibility. The tags check
      // makes historical rows visible without a data migration; captureMethod
      // is the explicit discriminator for new rows.
      WHERE (t.userId = $userId
             OR t.captureMethod = 'inline-tag'
             OR size(coalesce(t.tags, [])) > 0)
        AND NOT (t)-[:PINNED_IN]->(:Conversation {id: $conversationId})
      OPTIONAL MATCH (author:User {id: t.userId})
      RETURN t {
        .id, .text, .kind, .status, .createdAt, .updatedAt,
        tags: coalesce(t.tags, []),
        sourceMessageId: m.id,
        sourceConversationId: m.conversationId,
        authorId: t.userId,
        authorName: author.name,
        pinned: false
      } AS thought
      ORDER BY t.createdAt DESC
      LIMIT 100
      `,
      { userId, conversationId }
    );

    res.json({
      pinned: pinnedResult.records.map((r) => toJS(r.get('thought'))),
      fromChat: mergeDuplicateThoughtsFromSameMessage(
        fromChatResult.records.map((r) => toJS(r.get('thought')) as Record<string, unknown>)
      ),
    });
  } catch (err) {
    console.error('GET /api/thoughts/conversation error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation thoughts' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/thoughts/:id/pin
 * Body: { conversationId }
 * Pins one of the caller's thoughts to a conversation they participate in.
 * Pinning shares the thought with all current participants (it appears in
 * their chat-scoped Thoughts view). Idempotent (MERGE).
 */
router.post('/:id/pin', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;
  const { conversationId } = req.body ?? {};

  if (!conversationId || typeof conversationId !== 'string') {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }

  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought {id: $id})
      WHERE t.lane IS NULL OR t.lane <> 'context'
      MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      MERGE (t)-[p:PINNED_IN]->(c)
      ON CREATE SET p.pinnedBy = $userId, p.pinnedAt = datetime($now)
      RETURN t { .id, .text, .kind, .status, .createdAt, .updatedAt, tags: coalesce(t.tags, []) } AS thought
      `,
      { userId, id, conversationId, now }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Thought or conversation not found (or not yours)' });
      return;
    }

    const thought = toJS(result.records[0].get('thought')) as Record<string, unknown>;

    // Live-update the conversation room so open chat-scoped views refresh.
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${conversationId}`).emit('thought:pinned', {
        conversationId,
        thought: { ...thought, pinned: true, pinnedBy: userId, pinnedAt: now, authorId: userId },
      });
    }

    res.json({ ...thought, pinned: true });
  } catch (err) {
    console.error('POST /api/thoughts/:id/pin error:', err);
    res.status(500).json({ error: 'Failed to pin thought' });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/thoughts/:id/pin/:conversationId
 * Unpins. Allowed for the thought's owner or whoever pinned it.
 */
router.delete('/:id/pin/:conversationId', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id, conversationId } = req.params;

  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (t:Thought {id: $id})-[p:PINNED_IN]->(c:Conversation {id: $conversationId})
      WHERE (t.userId = $userId OR p.pinnedBy = $userId) AND (t.lane IS NULL OR t.lane <> 'context')
      DELETE p
      RETURN count(p) AS removed
      `,
      { userId, id, conversationId }
    );

    const removed = toJS(result.records[0]?.get('removed')) as number;
    if (!removed) {
      res.status(404).json({ error: 'Pin not found or not yours to remove' });
      return;
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${conversationId}`).emit('thought:unpinned', { conversationId, thoughtId: id });
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/thoughts/:id/pin error:', err);
    res.status(500).json({ error: 'Failed to unpin thought' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/thoughts
 * Body: { text: string, kind?: ThoughtKind, status?: ThoughtStatus,
 *         sourceMessageId?: string, pinToConversationId?: string }
 * Creates a new Thought for the current user.
 *
 * sourceMessageId (save-to-thoughts from a chat message): links the thought
 * back to the message via :FROM_MESSAGE for provenance, after verifying the
 * caller participates in that message's conversation.
 * pinToConversationId: additionally pins the new thought to that conversation
 * in the same call ("Save & pin" — the unified affordance).
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const {
    text,
    kind = 'observation',
    status = 'none',
    sourceMessageId,
    pinToConversationId,
  } = req.body ?? {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required and must be non-empty' });
    return;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `text must be ≤ ${MAX_TEXT_LENGTH} characters` });
    return;
  }
  if (!VALID_KINDS.has(kind)) {
    res.status(400).json({ error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` });
    return;
  }
  if (!VALID_STATUSES.has(status)) {
    res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
    return;
  }

  if (sourceMessageId !== undefined && typeof sourceMessageId !== 'string') {
    res.status(400).json({ error: 'sourceMessageId must be a string' });
    return;
  }
  if (pinToConversationId !== undefined && typeof pinToConversationId !== 'string') {
    res.status(400).json({ error: 'pinToConversationId must be a string' });
    return;
  }

  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    const id = nanoid();

    // Provenance: verify the source message is in a conversation the caller
    // participates in (otherwise you could link thoughts to strangers'
    // messages / probe message ids).
    if (sourceMessageId) {
      const msgCheck = await session.run(
        `
        MATCH (m:Message {id: $sourceMessageId})
        MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: m.conversationId})
        RETURN m.conversationId AS convId
        `,
        { userId, sourceMessageId }
      );
      if (msgCheck.records.length === 0) {
        res.status(404).json({ error: 'Source message not found' });
        return;
      }
      if (pinToConversationId && msgCheck.records[0].get('convId') !== pinToConversationId) {
        res.status(400).json({ error: 'pinToConversationId must match the source message conversation' });
        return;
      }
    } else if (pinToConversationId) {
      const partCheck = await session.run(
        `MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $pinToConversationId}) RETURN c.id`,
        { userId, pinToConversationId }
      );
      if (partCheck.records.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
    }

    const result = await session.run(
      `
      MATCH (u:User {id: $userId})
      CREATE (t:Thought {
        id: $id,
        userId: $userId,
        text: $text,
        kind: $kind,
        status: $status,
        createdAt: datetime($now),
        updatedAt: datetime($now)
      })
      CREATE (u)-[:HAS_THOUGHT]->(t)
      WITH u, t
      OPTIONAL MATCH (m:Message {id: $sourceMessageId})
      FOREACH (msg IN CASE WHEN m IS NULL THEN [] ELSE [m] END |
        CREATE (t)-[:FROM_MESSAGE]->(msg)
      )
      WITH u, t
      OPTIONAL MATCH (pc:Conversation {id: $pinToConversationId})
      FOREACH (conv IN CASE WHEN pc IS NULL THEN [] ELSE [pc] END |
        MERGE (t)-[p:PINNED_IN]->(conv)
        ON CREATE SET p.pinnedBy = $userId, p.pinnedAt = datetime($now)
      )
      RETURN t { .id, .text, .kind, .status, .createdAt, .updatedAt, tags: coalesce(t.tags, []) } AS thought
      `,
      {
        userId,
        id,
        text: text.trim(),
        kind,
        status,
        now,
        sourceMessageId: sourceMessageId ?? null,
        pinToConversationId: pinToConversationId ?? null,
      }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const thought = toJS(result.records[0].get('thought')) as Record<string, unknown>;

    // Live updates: the owner's Thoughts tab, and — when pinned — the
    // conversation room's chat-scoped view.
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('thought:created', { thought });
      if (pinToConversationId) {
        io.to(`conversation:${pinToConversationId}`).emit('thought:pinned', {
          conversationId: pinToConversationId,
          thought: { ...thought, pinned: true, pinnedBy: userId, pinnedAt: now, authorId: userId },
        });
      }
    }

    res.status(201).json(thought);
  } catch (err) {
    console.error('POST /api/thoughts error:', err);
    res.status(500).json({ error: 'Failed to create thought' });
  } finally {
    await session.close();
  }
});

/**
 * PATCH /api/thoughts/:id
 * Body: { text?, kind?, status? }
 * Update the current user's thought. Ownership enforced via userId.
 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;
  const { text, kind, status } = req.body ?? {};

  if (text !== undefined) {
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text must be a non-empty string' });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: `text must be ≤ ${MAX_TEXT_LENGTH} characters` });
      return;
    }
  }
  if (kind !== undefined && !VALID_KINDS.has(kind)) {
    res.status(400).json({ error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` });
    return;
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
    return;
  }

  const session = getDriver().session();
  try {
    const now = new Date().toISOString();

    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought {id: $id})
      WHERE t.lane IS NULL OR t.lane <> 'context'
      SET t.text      = CASE WHEN $text   IS NOT NULL THEN $text   ELSE t.text   END,
          t.kind      = CASE WHEN $kind   IS NOT NULL THEN $kind   ELSE t.kind   END,
          t.status    = CASE WHEN $status IS NOT NULL THEN $status ELSE t.status END,
          t.updatedAt = datetime($now)
      RETURN t { .id, .text, .kind, .status, .createdAt, .updatedAt, tags: coalesce(t.tags, []) } AS thought
      `,
      {
        userId,
        id,
        text: text !== undefined ? text.trim() : null,
        kind: kind ?? null,
        status: status ?? null,
        now,
      }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Thought not found or not owned by you' });
      return;
    }

    const thought = toJS(result.records[0].get('thought'));

    const io = req.app.get("io");
    if (io) {
      io.to(`user:${userId}`).emit("thought:updated", { thought });
      // also notify conversations where it is pinned or shared
      try {
        const convs = await session.run(`MATCH (t:Thought {id: $id})-[:PINNED_TO|SHARED_IN]->(c:Conversation) RETURN DISTINCT c.id AS cid`, { id });
        for (const rec of convs.records) {
          io.to(`conversation:${rec.get("cid")}`).emit("thought:updated", { thought });
        }
      } catch (e) { /* ignore */ }
    }

    res.json(thought);
  } catch (err) {
    console.error('PATCH /api/thoughts/:id error:', err);
    res.status(500).json({ error: 'Failed to update thought' });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/thoughts/:id
 * Deletes the current user's thought. Returns 204 on success.
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;

  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought {id: $id})
      WHERE t.lane IS NULL OR t.lane <> 'context'
      DETACH DELETE t
      RETURN count(t) AS deleted
      `,
      { userId, id }
    );

    const deleted = result.records[0]?.get('deleted');
    const count = typeof deleted === 'object' && deleted !== null && 'toNumber' in deleted
      ? (deleted as { toNumber: () => number }).toNumber()
      : Number(deleted);

    if (count === 0) {
      res.status(404).json({ error: 'Thought not found or not owned by you' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/thoughts/:id error:', err);
    res.status(500).json({ error: 'Failed to delete thought' });
  } finally {
    await session.close();
  }
});

export default router;
