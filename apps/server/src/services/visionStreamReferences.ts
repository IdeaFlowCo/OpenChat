import neo4j, { type Driver } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { ownerKeyFor, parseAskFilter } from './overlay/contract.js';
import { listAsksIn } from './overlay/store.js';

const LIMIT = 20;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

// Match privateGraph's canonical OverlayStore database while keeping the app's
// User and Thought reads on their existing default database.
async function readCanonicalAsks(driver: Driver, owner: string) {
  const session = driver.session({
    database: process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: 'READ',
  });
  try {
    return await session.executeRead(tx =>
      listAsksIn(tx, owner, parseAskFilter({ status: 'all', limit: LIMIT })),
    );
  } finally {
    await session.close();
  }
}

export async function readVisionStreamReferences(
  userId: string,
  issuer: string,
  subject: string,
  driver: Driver = getDriver(),
) {
  const owner = ownerKeyFor(issuer, subject);
  const session = driver.session({ defaultAccessMode: 'READ' });
  try {
    const linked = async () => {
      const { records } = await session.run(
        'MATCH (u:User {ideaflowIssuer:$issuer, ideaflowSub:$subject}) RETURN u.id AS id LIMIT 2',
        { issuer, subject },
      );
      return records.length === 1 && records[0].get('id') === userId;
    };
    if (!await linked()) return null;
    // Use the canonical read directly. The app's list wrapper can migrate a
    // legacy owner on first read; a cross-app projection never performs it.
    const { asks, truncated } = await readCanonicalAsks(driver, owner);
    // Admit standalone observation references only. A tag capture, pinned
    // chat entry, or Context lane row can carry chat content and is excluded.
    const { records } = await session.run(`
      MATCH (:User {id:$userId, ideaflowIssuer:$issuer, ideaflowSub:$subject})-[:HAS_THOUGHT]->(t:Thought)
      WHERE t.userId = $userId AND t.kind = 'observation' AND t.deletedAt IS NULL
        AND (t.lane IS NULL OR t.lane <> 'context') AND t.scopeConversationId IS NULL
        AND NOT EXISTS { MATCH (t)-[:FROM_MESSAGE|PINNED_IN]->() }
      RETURN DISTINCT t.id AS id, toString(t.createdAt) AS createdAt, toString(t.updatedAt) AS updatedAt
      ORDER BY createdAt DESC, id DESC LIMIT $limit
    `, { userId, issuer, subject, limit: neo4j.int(LIMIT + 1) });
    if (!await linked()) return null;

    const base = { owner, audience: 'owner' as const, origin: 'openchat' as const };
    return {
      version: 1,
      truncated: truncated || records.length > LIMIT,
      items: [
        ...asks.filter(ask => ID.test(ask.id)).map(ask => ({
          ...base, namespace: 'noos.ask', sourceId: ask.id, kind: 'ask',
          revision: ask.revision, time: ask.updatedAt, status: ask.status,
          excerpt: ask.text.replace(/\s+/g, ' ').trim().slice(0, 160),
        })),
        ...records.slice(0, LIMIT).flatMap(record => {
          const id = record.get('id');
          const updatedAt = record.get('updatedAt');
          const createdAt = record.get('createdAt');
          if (typeof id !== 'string' || !ID.test(id) || typeof createdAt !== 'string') return [];
          // Thoughts have no integer revision. The source update clock is
          // carried as a version string only when the source recorded it.
          return [{
            ...base, namespace: 'openchat.thought', sourceId: id, kind: 'note',
            revision: typeof updatedAt === 'string' ? updatedAt : null,
            time: updatedAt ?? createdAt,
          }];
        }),
      ],
    };
  } finally {
    await session.close();
  }
}
