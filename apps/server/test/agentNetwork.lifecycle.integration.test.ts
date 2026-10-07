import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver, type Transaction, type Session } from 'neo4j-driver';
const state = vi.hoisted(() => ({ driver: null as any, afterEligibility: null as null | (() => Promise<void>) }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));
vi.mock('../src/services/assistant.js', () => ({
  ASSISTANT_USER_ID: 'synthetic-assistant', ensureAssistantUser: async () => {},
  ensureAssistantConversation: async () => 'synthetic-conversation', persistMessage: async () => ({ created: false }),
}));
vi.mock('../src/services/directConversation.js', () => ({ ensureDirectConversation: async () => ({ conversation: { id: 'synthetic-direct' } }) }));
import { scanIntentForMatches, respondToMatch } from '../src/services/agentNetwork.js';
import { acquireContextAclLocks } from '../src/services/contextAccess.js';
import { reconcileIntentionLifecycle } from '../src/services/contextIntentions.js';
const integration = process.env.NEO4J_TEST_URI ? describe.sequential : describe.skip;
integration('network match lifecycle serialization with real Neo4j', () => {
  let driver: Driver;
  const prefix = `match-life-${crypto.randomUUID()}`, a = `${prefix}-a`, b = `${prefix}-b`, ask = `${prefix}-ask`, offer = `${prefix}-offer`, match = `${prefix}-match`;
  const session = async <T>(fn: (s: Session) => Promise<T>) => { const s = driver.session(); try { return await fn(s); } finally { await s.close(); } };
  const run = (q: string, p: any = {}) => session(s => s.run(q, p));
  const cleanup = () => run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.ownerUserId IN [$a,$b]
    OR (n:AgentMatch AND EXISTS { MATCH (n)-[:MATCHES]->(:AgentIntent {id:$ask}) }) DETACH DELETE n`, { prefix, a, b, ask });
  beforeAll(() => {
    driver = neo4j.driver(process.env.NEO4J_TEST_URI!, neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD || 'test'));
    state.driver = { session: () => {
      const s = driver.session();
      const after = async (result: any) => {
        if (state.afterEligibility && result?.records?.[0]?.keys.includes('eligible') && !result.records[0].keys.includes('matchStatus')) {
          const hook = state.afterEligibility; state.afterEligibility = null; await hook();
        }
        return result;
      };
      return {
        run: async (q: string, p: any) => after(await s.run(q, p)), close: s.close.bind(s),
        executeWrite: async (fn: any) => after(await s.executeWrite(fn)),
      };
    } };
  });
  beforeEach(async () => {
    state.afterEligibility = null; await cleanup();
    await run(`CREATE (a:User {id:$a}),(b:User {id:$b}),
      (ask:AgentIntent {id:$ask,ownerUserId:$a,kind:'ask',terms:'synthetic help',status:'active',lifecycleState:'open',audienceRestricted:true,audienceUserIds:[$b],createdAt:datetime()}),
      (offer:AgentIntent {id:$offer,ownerUserId:$b,kind:'offer',terms:'synthetic help',status:'active',lifecycleState:'open',audienceRestricted:true,audienceUserIds:[$a],createdAt:datetime()})
      CREATE (a)-[:OWNS_INTENT]->(ask),(b)-[:OWNS_INTENT]->(offer)`, { a, b, ask, offer });
  });
  afterAll(async () => { await cleanup(); await driver.close(); });
  const holdOwner = async () => {
    const s = driver.session(), tx = s.beginTransaction();
    await acquireContextAclLocks(tx as any, { userIds: [a] });
    return { s, tx };
  };
  const fulfill = async (tx: Transaction) => { await reconcileIntentionLifecycle(tx as any, ask, 'fulfilled', new Date().toISOString()); await tx.commit(); };
  const remainsBlocked = async (pending: Promise<unknown>) => {
    const status = await Promise.race([pending.then(() => 'finished'), new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 100))]);
    expect(status).toBe('blocked');
  };
  it('keeps a scored scan behind owner closure and rejects its stale candidate', async () => {
    let scored!: () => void; const scoringReached = new Promise<void>(resolve => { scored = resolve; });
    let release!: () => void; const scoreGate = new Promise<void>(resolve => { release = resolve; });
    const pending = scanIntentForMatches(ask, { scoring: { embeddingScore: async () => { scored(); await scoreGate; return 1; }, verify: async () => true, threshold: 0 } });
    await scoringReached;
    const held = await holdOwner();
    try {
      release(); await remainsBlocked(pending); await fulfill(held.tx);
      expect(await pending).toEqual([]);
      expect((await run('MATCH (m:AgentMatch)-[:MATCHES]->(:AgentIntent {id:$ask}) RETURN m', { ask })).records).toHaveLength(0);
    } finally { await held.tx.close(); await held.s.close(); await pending; }
  });
  it('rechecks final approval after acquiring the same owner lock as fulfillment', async () => {
    await run(`MATCH (ask:AgentIntent {id:$ask}),(offer:AgentIntent {id:$offer})
      CREATE (m:AgentMatch {id:$match,status:'proposed',bResponse:'approved',createdAt:datetime(),updatedAt:datetime()})
      CREATE (m)-[:MATCHES]->(ask),(m)-[:MATCHES]->(offer)`, { ask, offer, match });
    let held: Awaited<ReturnType<typeof holdOwner>> | undefined;
    let ready!: () => void; const reached = new Promise<void>(resolve => { ready = resolve; });
    state.afterEligibility = async () => { held = await holdOwner(); ready(); };
    const pending = respondToMatch(a, match, 'approve');
    await reached;
    try {
      await remainsBlocked(pending); await fulfill(held!.tx);
      expect(await pending).toMatchObject({ status: 'closed' });
      const row = (await run('MATCH (m:AgentMatch {id:$match}) RETURN m', { match })).records[0].get('m').properties;
      expect(row.status).toBe('closed'); expect(row.aResponse).toBeUndefined(); expect(row.conversationId).toBeUndefined();
    } finally { await held!.tx.close(); await held!.s.close(); await pending; }
  });
});
