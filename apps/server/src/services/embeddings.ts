/**
 * Embeddings service (openchat-bfn.2) — semantic search support.
 *
 * Wraps OpenAI's text-embedding-3-small (1536 dims) behind a graceful-
 * degradation boundary: if OPENAI_API_KEY is unset we return null and the
 * caller falls back to keyword search. We never read a key file or hardcode
 * a key — only process.env.OPENAI_API_KEY.
 *
 * The embedding is stored on Message nodes as m.embedding (a list of floats)
 * and queried via the `message_embedding` Neo4j vector index.
 */

import { getDriver } from '../db.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const VECTOR_INDEX_NAME = 'message_embedding';

let _warnedMissingKey = false;

/**
 * Whether embeddings are available (i.e. an OpenAI key is configured). Callers
 * use this to decide between hybrid/semantic and plain keyword search.
 */
export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Embed a single string. Returns a 1536-float vector, or null when:
 *   - OPENAI_API_KEY is unset (logged once),
 *   - the text is empty/whitespace,
 *   - the API call fails (logged, non-throwing).
 */
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (!_warnedMissingKey) {
      console.warn('[embeddings] OPENAI_API_KEY not set — semantic search disabled (keyword search still works).');
      _warnedMissingKey = true;
    }
    return null;
  }

  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;

  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        // Cap input length to keep token cost bounded; embedding-3-small
        // handles ~8k tokens but chat messages are tiny.
        input: trimmed.slice(0, 8000),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[embeddings] OpenAI error ${resp.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const json = (await resp.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      console.warn('[embeddings] OpenAI returned no embedding vector.');
      return null;
    }
    return vec;
  } catch (err) {
    console.warn('[embeddings] embedText failed:', err);
    return null;
  }
}

/**
 * Idempotently create the Neo4j vector index over Message.embedding.
 * Neo4j 5.15 syntax. Wrapped in try/catch by the caller; safe to call on
 * every boot (IF NOT EXISTS).
 */
export async function ensureVectorIndex(): Promise<void> {
  const s = getDriver().session();
  try {
    await s.run(`
      CREATE VECTOR INDEX ${VECTOR_INDEX_NAME} IF NOT EXISTS
      FOR (m:Message) ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS},
        \`vector.similarity_function\`: 'cosine'
      }}
    `);
  } finally {
    await s.close();
  }
}

/**
 * Best-effort: embed a message's content and SET m.embedding on the node.
 * Fire-and-forget from the send paths — never blocks the send, swallows
 * errors. Uses its own session.
 */
export async function embedAndStoreMessage(messageId: string, content: string): Promise<void> {
  if (!embeddingsEnabled()) return;
  const vec = await embedText(content);
  if (!vec) return;
  const s = getDriver().session();
  try {
    await s.run(
      `MATCH (m:Message {id: $messageId}) SET m.embedding = $embedding`,
      { messageId, embedding: vec }
    );
  } catch (err) {
    console.warn('[embeddings] failed to store embedding:', err);
  } finally {
    await s.close();
  }
}

export interface SemanticHit {
  content: string;
  conversationId: string;
  score: number;
  createdAt: string;
  senderName?: string | null;
}

/**
 * Semantic search over the calling user's messages.
 *
 * 1. embed the query (null → caller should fall back to keyword)
 * 2. CALL db.index.vector.queryNodes to get top-K nearest Message nodes
 * 3. keep only nodes whose conversationId is one the user PARTICIPATES_IN
 *    (the access-control boundary — identical to the keyword /search path)
 *
 * Returns null when embeddings are unavailable (no key / embed failed) so the
 * caller can degrade to keyword search; returns [] for "enabled but no hits".
 */
export async function semanticSearchMessages(
  userId: string,
  query: string,
  limit = 10
): Promise<SemanticHit[] | null> {
  const qVec = await embedText(query);
  if (!qVec) return null;

  // Over-fetch from the vector index, then filter by the user's conversations
  // and trim to `limit`. We fetch a generous multiple because the raw nearest
  // neighbours include messages from conversations the user can't see.
  const k = Math.min(Math.max(limit * 5, 50), 500);

  const s = getDriver().session();
  try {
    const result = await s.run(
      `
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
      WITH collect(c.id) AS cids
      CALL db.index.vector.queryNodes($indexName, $k, $qVec)
      YIELD node, score
      WITH node AS m, score, cids
      WHERE m.conversationId IN cids
        AND m.deletedAt IS NULL
      OPTIONAL MATCH (sender:User {id: m.senderId})
      RETURN m.content AS content,
             m.conversationId AS conversationId,
             m.createdAt AS createdAt,
             sender.name AS senderName,
             score
      ORDER BY score DESC
      LIMIT $limit
      `,
      {
        userId,
        indexName: VECTOR_INDEX_NAME,
        k: Math.trunc(k),
        qVec,
        limit: Math.trunc(limit),
      }
    );

    return result.records.map((r) => {
      const createdAt = r.get('createdAt');
      return {
        content: (r.get('content') as string) ?? '',
        conversationId: r.get('conversationId') as string,
        score: typeof r.get('score') === 'number' ? (r.get('score') as number) : Number(r.get('score')),
        createdAt: createdAt?.toString?.() ?? String(createdAt ?? ''),
        senderName: (r.get('senderName') as string | null) ?? null,
      };
    });
  } catch (err) {
    // Index might not exist yet (boot race) or query syntax issue → degrade.
    console.warn('[embeddings] semanticSearchMessages failed:', err);
    return null;
  } finally {
    await s.close();
  }
}
