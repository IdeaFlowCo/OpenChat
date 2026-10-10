import { afterAll, beforeAll, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { UNLINKED_PARTNER_IDENTITIES_QUERY } from '../src/queries/unlinkedIdentities.js';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const run = uri && user && password ? it : it.skip;
const issuer = 'https://id.ideaflow.app/api/auth';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const id = (name: string) => `ident-${name}-${suffix}`;
let driver: Driver;

beforeAll(async () => {
  if (!uri || !user || !password) return;
  driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session();
  try {
    await session.run(`
      CREATE (viewer:User {id: $viewer, ideaflowIssuer: $issuer, ideaflowSub: $viewerSub, ideaflowIdentityKey: $viewerKey})
      CREATE (partner:User {id: $partner, ideaflowIssuer: $issuer, ideaflowSub: 'partner-sub', ideaflowIdentityKey: $partnerKey, email: 'partner@example.test', name: 'Partner'})
      CREATE (twice:User {id: $twice, ideaflowIssuer: $issuer, ideaflowSub: 'twice-sub'})
      CREATE (legacy:User {id: $legacy, email: 'legacy@example.test'})
      CREATE (blocker:User {id: $blocker, ideaflowIssuer: $issuer, ideaflowSub: 'blocker-sub'})
      CREATE (blocked:User {id: $blocked, ideaflowIssuer: $issuer, ideaflowSub: 'blocked-sub'})
      CREATE (stranger:User {id: $stranger, ideaflowIssuer: $issuer, ideaflowSub: 'stranger-sub'})
      CREATE (other:User {id: $otherViewer, ideaflowIssuer: $issuer, ideaflowSub: 'other-viewer-sub'})
      FOREACH (pair IN [[$partner, $c1], [$twice, $c2], [$twice, $c3], [$legacy, $c4], [$blocker, $c5], [$blocked, $c6]] |
        MERGE (c:Conversation {id: pair[1]})
        MERGE (viewer)-[:PARTICIPATES_IN]->(c))
      WITH viewer, partner, twice, legacy, blocker, blocked, stranger, other
      MATCH (c1:Conversation {id: $c1}), (c2:Conversation {id: $c2}), (c3:Conversation {id: $c3}), (c4:Conversation {id: $c4}), (c5:Conversation {id: $c5}), (c6:Conversation {id: $c6})
      CREATE (partner)-[:PARTICIPATES_IN]->(c1), (twice)-[:PARTICIPATES_IN]->(c2), (twice)-[:PARTICIPATES_IN]->(c3),
        (legacy)-[:PARTICIPATES_IN]->(c4), (blocker)-[:PARTICIPATES_IN]->(c5), (blocked)-[:PARTICIPATES_IN]->(c6),
        (blocker)-[:BLOCKED]->(viewer), (viewer)-[:BLOCKED]->(blocked)
      CREATE (sc:Conversation {id: $c7}) CREATE (stranger)-[:PARTICIPATES_IN]->(sc) CREATE (other)-[:PARTICIPATES_IN]->(sc)
    `, { issuer, viewer: id('viewer'), viewerSub: `viewer-sub-${suffix}`, viewerKey: `${issuer}\u001fviewer-sub-${suffix}`, partner: id('partner'), partnerKey: `${issuer}\u001fpartner-sub-${suffix}`,
      twice: id('twice'), legacy: id('legacy'), blocker: id('blocker'), blocked: id('blocked'), stranger: id('stranger'), otherViewer: id('other'),
      c1: id('c1'), c2: id('c2'), c3: id('c3'), c4: id('c4'), c5: id('c5'), c6: id('c6'), c7: id('c7') });
  } finally { await session.close(); }
});

afterAll(async () => {
  if (!driver) return;
  const session = driver.session();
  try {
    await session.run('MATCH (n) WHERE (n:User OR n:Conversation) AND n.id ENDS WITH $suffix DETACH DELETE n', { suffix: `-${suffix}` });
  } finally { await session.close(); await driver.close(); }
});

const ask = async (subject: string, userIds: string[]) => {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(UNLINKED_PARTNER_IDENTITIES_QUERY, { key: `${issuer}\u001f${subject}`, issuer, subject, userIds });
    return result.records.map(record => record.toObject());
  } finally { await session.close(); }
};

run('returns only partners with a shared identity: once each, never strangers, legacy accounts or blocked pairs', async () => {
  const everyone = ['partner', 'twice', 'legacy', 'blocker', 'blocked', 'stranger', 'other'].map(id);
  const rows = await ask(`viewer-sub-${suffix}`, everyone);
  expect(rows.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
    { userId: id('partner'), subject: 'partner-sub' },
    { userId: id('twice'), subject: 'twice-sub' },
  ]);
  for (const row of rows) expect(Object.keys(row).sort()).toEqual(['subject', 'userId']);
});

run('an unknown member, or a member without a shared inbox key, learns nothing', async () => {
  expect(await ask('nobody-sub', [id('partner')])).toEqual([]);
  expect(await ask('other-viewer-sub', [id('stranger')])).toEqual([]);
});
