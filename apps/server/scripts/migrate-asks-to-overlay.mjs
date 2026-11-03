/**
 * Move asks into the Noos overlay's `ask` kind (OpenChat-2fsy.1): every
 * `[friend-ask v1]` overlay note becomes an ask by the person it is on (the
 * note stays until the migration is checked), and every OpenChat note-review
 * ask (`OpenChatPrivateAsk`) becomes an ask by its subject (its node stays,
 * marked `migratedTo`; review undo ledgers are re-pointed). Idempotent.
 *
 * Run it right after the release that ships the ask kind: from then on the app
 * reads note-review asks from the overlay only.
 *
 * DRY RUN by default; pass --apply to write. Prints counts and ids only, never
 * ask text.
 *
 * HOW TO RUN (Neo4j is internal to the prod docker network, so run in-container):
 *   noos-scp apps/server/scripts/migrate-asks-to-overlay.mjs noos:/tmp/
 *   noos-ssh --command='sudo docker cp /tmp/migrate-asks-to-overlay.mjs openchat_app:/app/apps/server/ \
 *     && sudo docker exec -w /app/apps/server openchat_app node migrate-asks-to-overlay.mjs [--apply] \
 *     ; sudo docker exec openchat_app rm -f /app/apps/server/migrate-asks-to-overlay.mjs'
 */
import neo4j from 'neo4j-driver';
import { migrateAsksToOverlay } from './dist/services/askMigration.js';

const driver = neo4j.driver(process.env.NEO4J_URI || 'bolt://noos_neo4j:7687', neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || ''));
try {
  const report = await migrateAsksToOverlay(driver, process.env.NEO4J_DATABASE || 'neo4j', { apply: process.argv.includes('--apply') });
  console.log(JSON.stringify(report, null, 2));
} finally { await driver.close(); }
