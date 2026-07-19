/**
 * Thoughts Stream API — personal notes feed (OpenChat-zi1)
 *
 * :Thought { id, userId, text, kind, status, createdAt, updatedAt }
 * kind:   'fact' | 'decision' | 'commitment' | 'reminder' | 'observation'
 * status: 'none' | 'open' | 'closed'
 *
 * All routes require auth. Users can also read tag-extracted Thoughts from
 * groups they currently belong to, but only owners can modify Thoughts.
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
 * GET /api/thoughts?limit=50&before=<ISO createdAt>&conversationId=<id>
 * List the current user's thoughts plus visible group-tagged thoughts.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  const conversationId = typeof req.query.conversationId === 'string'
    ? req.query.conversationId.trim()
    : null;
  // Search (?q=) — matches Thought text OR any of its tags (case-insensitive).
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;

  const conds: string[] = [];
  if (before) conds.push('t.createdAt < datetime($before)');
  if (conversationId) conds.push('m.conversationId = $conversationId');
  if (q)
    conds.push(
      '(toLower(t.text) CONTAINS toLower($q) OR any(tag IN coalesce(t.tags, []) WHERE toLower(tag) CONTAINS toLower($q)))'
    );
  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (owner:User)-[:HAS_THOUGHT]->(t:Thought)
      OPTIONAL MATCH (t)-[:FROM_MESSAGE]->(m:Message)
      OPTIONAL MATCH (conv:Conversation { id: m.conversationId })
      WHERE (
        owner.id = $userId
        OR (
          conv.type = 'group'
          AND EXISTS {
            MATCH (:User {id: $userId})-[:PARTICIPATES_IN]->(conv)
          }
        )
      )
      ${conds.length ? `AND ${conds.join(' AND ')}` : ''}
      RETURN t {
        .id, .text, .kind, .status, .createdAt, .updatedAt,
        tags: coalesce(t.tags, []),
        ownerId: owner.id,
        authorName: coalesce(owner.name, 'Group member'),
        isOwn: owner.id = $userId,
        sourceMessageId: m.id,
        sourceConversationId: m.conversationId,
        sourceConversationName: coalesce(conv.title, conv.name),
        sourceConversationType: conv.type
      } AS thought
      ORDER BY t.createdAt DESC
      LIMIT $limit
      `,
      // Neo4j's LIMIT clause requires a true integer; JS Number(50) gets
      // serialized as 50.0 and Neo4j rejects it. Wrap via neo4j.int().
      // Same pattern as server/src/routes/chat.ts:796.
      {
        userId,
        before: before ?? undefined,
        q: q ?? undefined,
        conversationId: conversationId ?? undefined,
        limit: neo4j.int(limit),
      }
    );

    const thoughts = result.records.map((r) => toJS(r.get('thought')));
    res.json(thoughts);
  } catch (err) {
    console.error('GET /api/thoughts error:', err);
    res.status(500).json({ error: 'Failed to fetch thoughts' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/thoughts
 * Body: { text: string, kind?: ThoughtKind, status?: ThoughtStatus }
 * Creates a new Thought for the current user.
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { text, kind = 'observation', status = 'none' } = req.body ?? {};

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

  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    const id = nanoid();

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
      RETURN t { .id, .text, .kind, .status, .createdAt, .updatedAt, tags: coalesce(t.tags, []) } AS thought
      `,
      { userId, id, text: text.trim(), kind, status, now }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const thought = toJS(result.records[0].get('thought'));
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
