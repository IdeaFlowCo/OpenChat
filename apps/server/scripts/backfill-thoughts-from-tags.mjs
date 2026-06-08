/**
 * Backfill Thoughts from #tags in EXISTING messages (openchat — thoughts-from-tags).
 *
 * The live extractor (createThoughtsFromMessageTags) only runs on SEND, so any
 * message that predates the feature — or is bulk-imported (iMessage, historical
 * exports, etc.) — never produced Thoughts. This script scans existing messages,
 * extracts their #tags, and creates the missing Thoughts.
 *
 * IDEMPOTENT: skips any message that already has a (:Thought)-[:FROM_MESSAGE]->
 * link, so it's safe to re-run after each import.
 *
 * Reuses the SAME extraction + creation logic as the live path (imports the
 * compiled dist service) so backfilled Thoughts match send-time ones exactly.
 *
 * HOW TO RUN (Neo4j is internal to the prod docker network, so run in-container):
 *   scp apps/server/scripts/backfill-thoughts-from-tags.mjs noos-prod:/tmp/
 *   ssh noos-prod 'sudo docker cp /tmp/backfill-thoughts-from-tags.mjs openchat_app:/app/apps/server/ \
 *     && sudo docker exec -w /app/apps/server openchat_app node backfill-thoughts-from-tags.mjs \
 *     && sudo docker exec openchat_app rm -f /app/apps/server/backfill-thoughts-from-tags.mjs'
 *
 * Locally (if you can reach Neo4j): NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD env + `node` it.
 */
import neo4j from 'neo4j-driver';
import {
  createThoughtsFromMessageTags,
  extractTagsFromMessage,
} from './dist/services/extractThoughtsFromMessage.js';

const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://noos_neo4j:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || '')
);

async function main() {
  const read = driver.session();
  let candidates;
  try {
    // Messages that (a) are real chat messages, (b) contain a '#', (c) aren't
    // deleted, and (d) don't already have a Thought. Cheap CONTAINS filter here;
    // the authoritative tag check happens in JS via extractTagsFromMessage.
    const res = await read.run(`
      MATCH (m:Message)
      WHERE m.conversationId IS NOT NULL
        AND m.content IS NOT NULL
        AND m.content CONTAINS '#'
        AND m.deletedAt IS NULL
        AND NOT EXISTS { MATCH (m)<-[:FROM_MESSAGE]-(:Thought) }
      RETURN m.id AS id, m.senderId AS senderId,
             m.conversationId AS conversationId, m.content AS content
    `);
    candidates = res.records.map((r) => ({
      id: r.get('id'),
      senderId: r.get('senderId'),
      conversationId: r.get('conversationId'),
      content: r.get('content'),
    }));
  } finally {
    await read.close();
  }

  console.log(`candidate messages (have '#', no Thought yet): ${candidates.length}`);

  let processed = 0;
  let created = 0;
  for (const m of candidates) {
    const tags = extractTagsFromMessage(m.content);
    if (!tags.length) continue; // '#' but no real tag (e.g. "C# is great")
    const ws = driver.session();
    try {
      const ids = await createThoughtsFromMessageTags(ws, {
        senderId: m.senderId,
        messageId: m.id,
        conversationId: m.conversationId,
        content: m.content,
        // no `io` — backfill doesn't emit live socket events
      });
      processed += 1;
      created += ids.length;
    } catch (e) {
      console.warn(`  failed for message ${m.id}:`, e.message);
    } finally {
      await ws.close();
    }
  }

  console.log(`done — messages with tags: ${processed}, Thoughts created: ${created}`);
}

main()
  .catch((e) => {
    console.error('backfill failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await driver.close();
    process.exit(process.exitCode || 0);
  });
