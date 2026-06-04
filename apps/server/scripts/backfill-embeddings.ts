/**
 * Backfill embeddings for existing Messages (openchat-bfn.2).
 *
 * One-off, manual: embeds every Message node that has content but no
 * `embedding` yet, so older messages become semantically searchable.
 *
 * Run (do NOT run automatically — requires OPENAI_API_KEY + Neo4j env):
 *   cd apps/server
 *   OPENAI_API_KEY=sk-... NEO4J_URI=bolt://... NEO4J_USER=neo4j NEO4J_PASSWORD=... \
 *     npx tsx scripts/backfill-embeddings.ts
 *
 * Lives OUTSIDE src/ so `npm run build` (rootDir: src) ignores it. It imports
 * the same embeddings service used at runtime, so behavior matches exactly.
 *
 * Idempotent + resumable: re-running only picks up messages still missing an
 * embedding. Processes in batches with a small concurrency cap to respect
 * OpenAI rate limits.
 */

import { getDriver, closeDatabase } from '../src/db.js';
import { embedText, embeddingsEnabled } from '../src/services/embeddings.js';

const BATCH_SIZE = 100;
const CONCURRENCY = 5;

async function fetchBatch(): Promise<Array<{ id: string; content: string }>> {
  const s = getDriver().session();
  try {
    const result = await s.run(
      `MATCH (m:Message)
       WHERE m.embedding IS NULL
         AND m.content IS NOT NULL
         AND m.content <> ''
         AND m.deletedAt IS NULL
       RETURN m.id AS id, m.content AS content
       LIMIT $limit`,
      { limit: BATCH_SIZE }
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      content: r.get('content') as string,
    }));
  } finally {
    await s.close();
  }
}

async function storeEmbedding(id: string, embedding: number[]): Promise<void> {
  const s = getDriver().session();
  try {
    await s.run(`MATCH (m:Message {id: $id}) SET m.embedding = $embedding`, { id, embedding });
  } finally {
    await s.close();
  }
}

async function processOne(msg: { id: string; content: string }): Promise<boolean> {
  const vec = await embedText(msg.content);
  if (!vec) return false;
  await storeEmbedding(msg.id, vec);
  return true;
}

async function main(): Promise<void> {
  if (!embeddingsEnabled()) {
    console.error('OPENAI_API_KEY is not set — cannot backfill embeddings. Aborting.');
    process.exit(1);
  }

  let totalDone = 0;
  let totalFailed = 0;

  for (;;) {
    const batch = await fetchBatch();
    if (batch.length === 0) break;

    // Process with a small concurrency cap.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map(processOne));
      for (const ok of results) ok ? totalDone++ : totalFailed++;
    }

    console.log(`Progress: embedded ${totalDone}, failed ${totalFailed} (batch of ${batch.length})`);

    // If a whole batch failed to embed, bail to avoid a tight error loop.
    if (totalFailed > 0 && totalDone === 0) {
      console.error('All embeds failing — check OPENAI_API_KEY / quota. Aborting.');
      break;
    }
  }

  console.log(`Backfill complete. Embedded: ${totalDone}, failed: ${totalFailed}.`);
  await closeDatabase();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
