import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('agent-network quiet-match loop', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userIds = [
    'happy-a', 'happy-b', 'decline-a', 'decline-b', 'reuse-a', 'reuse-b',
    'scan-a', 'scan-b', 'race-a', 'race-b', 'collision-a', 'collision-b',
    'recovery-a', 'recovery-b',
  ]
    .map((prefix) => `${prefix}-${suffix}`);
  const [
    happyA, happyB, declineA, declineB, reuseA, reuseB, scanA, scanB,
    raceA, raceB, collisionA, collisionB, recoveryA, recoveryB,
  ] = userIds as [string, string, string, string, string, string, string, string, string, string, string, string, string, string];
  let driver: Driver;
  let service: typeof import('../src/services/agentNetwork.js');
  let directService: typeof import('../src/services/directConversation.js');
  let database: typeof import('../src/db.js');
  let assistantService: typeof import('../src/services/assistant.js');

  const scoring = {
    embeddingScore: async () => null,
    verify: async () => true,
    threshold: 1,
  };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    database = await import('../src/db.js');
    service = await import('../src/services/agentNetwork.js');
    directService = await import('../src/services/directConversation.js');
    assistantService = await import('../src/services/assistant.js');
    await database.initDatabase();
    await service.ensureAgentIntentIndexes();
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
      await database.closeDatabase();
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

  it('claims a concurrent intent pair exactly once', async () => {
    const token = `scantoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const ask = await service.createIntent(scanA, { kind: 'ask', terms: token }, { queueScan: false });
    const offer = await service.createIntent(scanB, { kind: 'offer', terms: token }, { queueScan: false });
    const results = await Promise.all([
      service.scanIntentForMatches(ask.id, { scoring }),
      service.scanIntentForMatches(offer.id, { scoring }),
    ]);
    expect(results.flat()).toHaveLength(1);

    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (match:AgentMatch)-[:MATCHES]->(intent:AgentIntent)
         WHERE intent.id IN [$askId, $offerId]
         RETURN count(DISTINCT match) AS count`,
        { askId: ask.id, offerId: offer.id },
      );
      expect(result.records[0].get('count').toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('deduplicates a normal DM racing match completion', async () => {
    const token = `racetoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const matchId = await propose(raceA, raceB, token, 'race ask private', 'race offer private');
    await service.respondToMatch(raceA, matchId, 'approve');
    const [normal, connected] = await Promise.all([
      directService.ensureDirectConversation(raceA, raceB),
      service.respondToMatch(raceB, matchId, 'approve'),
    ]);
    expect(connected?.conversationId).toBe(normal.conversation.id);

    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (:User {id: $a})-[:PARTICIPATES_IN]->(conversation:Conversation {type: 'direct'})
         MATCH (:User {id: $b})-[:PARTICIPATES_IN]->(conversation)
         RETURN count(DISTINCT conversation) AS count`,
        { a: raceA, b: raceB },
      );
      expect(result.records[0].get('count').toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('keeps context-card identity separate from client message ids', async () => {
    const token = `collisiontoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const matchId = await propose(collisionA, collisionB, token, 'collision ask private', 'collision offer private');
    const selfDm = await directService.ensureDirectConversation(collisionA, collisionA);
    await assistantService.persistMessage(
      undefined,
      collisionA,
      selfDm.conversation.id as string,
      'client-selected id',
      { messageId: matchId },
    );
    await service.respondToMatch(collisionA, matchId, 'approve');
    const connected = await service.respondToMatch(collisionB, matchId, 'approve');

    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (card:Message {matchContextKey: $matchId})
         MATCH (client:Message {id: $matchId})
         RETURN card.id AS cardId, card.cardKind AS cardKind,
                card.conversationId AS cardConversationId,
                client.conversationId AS clientConversationId`,
        { matchId },
      );
      expect(result.records).toHaveLength(1);
      expect(result.records[0].get('cardId')).not.toBe(matchId);
      expect(result.records[0].get('cardKind')).toBe('match_context');
      expect(result.records[0].get('cardConversationId')).toBe(connected?.conversationId);
      expect(result.records[0].get('clientConversationId')).toBe(selfDm.conversation.id);
    } finally {
      await session.close();
    }
  });

  it('resumes connected matches whose durable completion was interrupted', async () => {
    const token = `recoverytoken${suffix.replace(/[^a-z0-9]/gi, '')}`;
    const matchId = await propose(recoveryA, recoveryB, token, 'recovery ask private', 'recovery offer private');
    const session = driver.session();
    try {
      await session.run(
        `MATCH (match:AgentMatch {id: $matchId})
         SET match.status = 'connected', match.aResponse = 'approved', match.bResponse = 'approved'
         REMOVE match.conversationId`,
        { matchId },
      );
    } finally {
      await session.close();
    }

    const recovered = await service.respondToMatch(recoveryA, matchId, 'approve');
    expect(recovered?.status).toBe('connected');
    expect(recovered?.conversationId).toBeTruthy();

    const retry = await service.respondToMatch(recoveryB, matchId, 'approve');
    expect(retry?.alreadyResolved).toBe(true);
    const check = driver.session();
    try {
      const result = await check.run(
        `MATCH (message:Message {matchContextKey: $matchId})
         RETURN count(message) AS count`,
        { matchId },
      );
      expect(result.records[0].get('count').toNumber()).toBe(1);
    } finally {
      await check.close();
    }
  });
});
