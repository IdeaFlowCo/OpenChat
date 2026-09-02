import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('agent-network quiet-match loop', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userIds = ['happy-a', 'happy-b', 'decline-a', 'decline-b', 'reuse-a', 'reuse-b']
    .map((prefix) => `${prefix}-${suffix}`);
  const [happyA, happyB, declineA, declineB, reuseA, reuseB] = userIds as [string, string, string, string, string, string];
  let driver: Driver;
  let service: typeof import('../src/services/agentNetwork.js');
  let directService: typeof import('../src/services/directConversation.js');
  let closeDatabase: typeof import('../src/db.js').closeDatabase;

  const scoring = {
    embeddingScore: async () => null,
    verify: async () => true,
    threshold: 1,
  };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    ({ closeDatabase } = await import('../src/db.js'));
    service = await import('../src/services/agentNetwork.js');
    directService = await import('../src/services/directConversation.js');
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $userIds AS userId
         CREATE (:User {id: userId, name: 'Private Test Name', email: userId + '@example.test'})`,
        { userIds },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run(
        `
        MATCH (user:User)-[:PARTICIPATES_IN]->(conversation:Conversation)
        WHERE user.id IN $userIds
        WITH collect(DISTINCT conversation) AS conversations
        UNWIND conversations AS conversation
        OPTIONAL MATCH (message:Message {conversationId: conversation.id})
        DETACH DELETE message, conversation
        `,
        { userIds },
      );
      await session.run(
        `MATCH (match:AgentMatch)-[:MATCHES]->(intent:AgentIntent)
         WHERE intent.ownerUserId IN $userIds
         DETACH DELETE match`,
        { userIds },
      );
      await session.run(
        `MATCH (intent:AgentIntent) WHERE intent.ownerUserId IN $userIds DETACH DELETE intent`,
        { userIds },
      );
      await session.run(
        `MATCH (user:User) WHERE user.id IN $userIds DETACH DELETE user`,
        { userIds },
      );
    } finally {
      await session.close();
      await driver.close();
      await closeDatabase();
    }
  });

  async function propose(
    askerId: string,
    offererId: string,
    token: string,
    askDetails: string,
    offerDetails: string,
  ): Promise<string> {
    await service.createIntent(askerId, {
      kind: 'ask', terms: token, details: askDetails,
    }, { queueScan: false });
    const offer = await service.createIntent(offererId, {
      kind: 'offer', terms: token, details: offerDetails,
    }, { queueScan: false });
    const [matchId] = await service.scanIntentForMatches(offer.id, { scoring });
    expect(matchId).toBeTruthy();
    return matchId!;
  }

  it('runs the anonymous two-user loop and creates exactly one context-card DM', async () => {
    const token = `happytoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const matchId = await propose(happyA, happyB, token, 'happy ask private', 'happy offer private');
    const [aView] = await service.listMatches(happyA);
    const [bView] = await service.listMatches(happyB);
    expect(aView?.otherKind).toBe('offer');
    expect(aView?.otherTerms).toBe(token);
    expect(bView?.otherKind).toBe('ask');
    const serializedViews = JSON.stringify([aView, bView]);
    expect(serializedViews).not.toContain(happyA);
    expect(serializedViews).not.toContain(happyB);
    expect(serializedViews).not.toContain('Private Test Name');
    expect(serializedViews).not.toContain('@example.test');
    expect(serializedViews).not.toContain('private');

    expect((await service.respondToMatch(happyA, matchId, 'approve'))?.status).toBe('awaiting_other');
    const connected = await service.respondToMatch(happyB, matchId, 'approve');
    expect(connected?.status).toBe('connected');
    expect(connected?.conversationId).toBeTruthy();

    const session = driver.session();
    try {
      const result = await session.run(
        `
        MATCH (a:User {id: $a})-[:PARTICIPATES_IN]->(conversation:Conversation {type: 'direct'})
        MATCH (b:User {id: $b})-[:PARTICIPATES_IN]->(conversation)
        WITH DISTINCT conversation
        MATCH (message:Message {conversationId: conversation.id})
        RETURN count(DISTINCT conversation) AS conversations,
               count(message) AS messages,
               collect(message.cardKind) AS cardKinds,
               collect(message.messageType) AS messageTypes
        `,
        { a: happyA, b: happyB },
      );
      expect(result.records[0].get('conversations').toNumber()).toBe(1);
      expect(result.records[0].get('messages').toNumber()).toBe(1);
      expect(result.records[0].get('cardKinds')).toEqual(['match_context']);
      expect(result.records[0].get('messageTypes')).toEqual(['card']);
    } finally {
      await session.close();
    }
  });

  it('closes anonymously on decline without creating a DM and leaves intents active', async () => {
    const token = `declinetoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const matchId = await propose(declineA, declineB, token, 'decline ask private', 'decline offer private');
    expect((await service.respondToMatch(declineB, matchId, 'decline'))?.status).toBe('closed');
    const aView = (await service.listMatches(declineA)).find((match) => match.id === matchId);
    expect(aView?.status).toBe('closed');
    expect(JSON.stringify(aView)).not.toContain(declineB);

    const session = driver.session();
    try {
      const result = await session.run(
        `
        MATCH (a:User {id: $a}), (b:User {id: $b})
        OPTIONAL MATCH (a)-[:PARTICIPATES_IN]->(conversation:Conversation {type: 'direct'})<-[:PARTICIPATES_IN]-(b)
        WITH conversation
        MATCH (intent:AgentIntent) WHERE intent.ownerUserId IN [$a, $b]
        RETURN count(DISTINCT conversation) AS conversations, collect(intent.status) AS statuses
        `,
        { a: declineA, b: declineB },
      );
      expect(result.records[0].get('conversations').toNumber()).toBe(0);
      expect(result.records[0].get('statuses')).toEqual(expect.arrayContaining(['active', 'active']));
    } finally {
      await session.close();
    }
  });

  it('reuses a pre-existing human DM instead of creating a duplicate', async () => {
    const existing = await directService.ensureDirectConversation(reuseA, reuseB);
    const token = `reusetoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const matchId = await propose(reuseA, reuseB, token, 'reuse ask private', 'reuse offer private');
    await service.respondToMatch(reuseA, matchId, 'approve');
    const connected = await service.respondToMatch(reuseB, matchId, 'approve');
    expect(connected?.conversationId).toBe(existing.conversation.id);

    const session = driver.session();
    try {
      const result = await session.run(
        `
        MATCH (a:User {id: $a})-[:PARTICIPATES_IN]->(conversation:Conversation {type: 'direct'})
        MATCH (b:User {id: $b})-[:PARTICIPATES_IN]->(conversation)
        RETURN count(DISTINCT conversation) AS count
        `,
        { a: reuseA, b: reuseB },
      );
      expect(result.records[0].get('count').toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });
});
