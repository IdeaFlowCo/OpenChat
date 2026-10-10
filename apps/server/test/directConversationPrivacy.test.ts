import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ driver: null as Driver | null }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));

import chatRouter from '../src/routes/chat.js';
import {
  DirectConversationNotAllowedError,
  ensureDirectConversation,
} from '../src/services/directConversation.js';
import { CONVERSATIONS_QUERY } from '../src/queries/chatUnread.js';
import { LEGACY_PLACEHOLDER_EMAIL_DOMAIN } from '../src/privacy/legacyEmailCompat.js';

const integration = process.env.NEO4J_TEST_URI ? describe : describe.skip;

integration('direct conversation privacy and first inbound message on real graph', () => {
  const prefix = `dm-privacy-${randomUUID()}`;
  const userIds = ['alice', 'bob', 'outsider'].map(name => `${prefix}-${name}`);
  const [alice, bob, outsider] = userIds;
  const conversationIds: string[] = [];
  const jwtSecret = `test-${randomUUID()}`;
  const app = express().use('/api/chat', chatRouter);
  let driver: Driver;

  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  function get(path: string, userId = alice) {
    const token = jwt.sign({ userId, email: `${userId}@example.test` }, jwtSecret);
    return request(app).get(`/api/chat${path}`).auth(token, { type: 'bearer' });
  }

  function expectPrivateUser(user: { id: string; email: string }) {
    expect(user.email).toBe(`${user.id}@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}`);
    expect(user.email).not.toBe(`${user.id}@example.test`);
  }

  function expectParticipants(participants: { user: { id: string; email: string; name: string; avatarUrl: string } }[]) {
    expect(participants.map(p => p.user.id).sort()).toEqual([alice, bob].sort());
    for (const { user } of participants) {
      expectPrivateUser(user);
      expect(user.name).toBe(user.id);
      expect(user.avatarUrl).toBe(`https://example.invalid/${user.id}.png`);
    }
  }

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', jwtSecret);
    driver = neo4j.driver(process.env.NEO4J_TEST_URI!, neo4j.auth.basic(
      process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD!,
    ));
    state.driver = driver;
    await query('CREATE INDEX IF NOT EXISTS FOR (m:Message) ON (m.conversationId)');
    await query('CALL db.awaitIndexes()');
    await query(`
      UNWIND $ids AS id
      CREATE (:User {id: id, name: id, email: id + '@example.test',
        avatarUrl: 'https://example.invalid/' + id + '.png'})
    `, { ids: userIds });
  });

  afterAll(async () => {
    if (!driver) return;
    try {
      await query('MATCH (m:Message) WHERE m.id STARTS WITH $prefix DETACH DELETE m', { prefix });
      await query('MATCH (c:Conversation) WHERE c.id IN $ids DETACH DELETE c', { ids: conversationIds });
      await query('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u', { ids: userIds });
    } finally {
      await driver.close();
      vi.unstubAllEnvs();
    }
  });

  it('returns private participants for creation, reuse, lists, detail and message senders', async () => {
    const result = await ensureDirectConversation(alice, bob);
    const id = result.conversation.id as string;
    conversationIds.push(id);
    expect(result.created).toBe(true);
    expectParticipants(result.conversation.participants as Parameters<typeof expectParticipants>[0]);
    const reused = await ensureDirectConversation(bob, alice);
    expect(reused.created).toBe(false);
    expect(reused.conversation.id).toBe(id);
    expectParticipants(reused.conversation.participants as Parameters<typeof expectParticipants>[0]);

    for (const userId of [alice, bob]) {
      const rows = await query(CONVERSATIONS_QUERY, { userId });
      expect(rows.records).toHaveLength(1);
      const conversation = rows.records[0].get('conversation');
      expect(conversation.id).toBe(id);
      expect(conversation.lastMessage).toBeNull();
      expect(Number(conversation.unreadCount)).toBe(0);
      expectParticipants(conversation.participants);
      const detail = await get(`/conversations/${id}`, userId);
      expect(detail.status).toBe(200);
      expectParticipants(detail.body.participants);
    }
    expect((await query(CONVERSATIONS_QUERY, { userId: outsider })).records).toEqual([]);
    expect((await get(`/conversations/${id}`, outsider)).status).toBe(404);
    expect((await get(`/conversations/${id}/messages`, outsider)).status).toBe(404);

    await query(`
      MATCH (a:User {id: $alice}), (b:User {id: $bob})
      CREATE (old:Message {id: $oldId, conversationId: $id, senderId: $alice,
        content: 'original', createdAt: datetime('2026-01-01T00:00:00Z')})
      CREATE (latest:Message {id: $latestId, conversationId: $id, senderId: $bob,
        content: 'first inbound reply', replyToId: $oldId,
        createdAt: datetime('2026-01-02T00:00:00Z')})
      CREATE (a)-[:SENT]->(old), (b)-[:SENT]->(latest)
    `, { alice, bob, id, oldId: `${prefix}-old`, latestId: `${prefix}-latest` });
    for (const userId of [alice, bob]) {
      const rows = await query(CONVERSATIONS_QUERY, { userId });
      expect(rows.records).toHaveLength(1);
      const conversation = rows.records[0].get('conversation');
      expect(conversation.id).toBe(id);
      expect(conversation.lastMessage).toMatchObject({
        id: `${prefix}-latest`, content: 'first inbound reply', senderId: bob, conversationId: id,
      });
      expect(Number(conversation.unreadCount)).toBe(1);
    }
    for (const suffix of ['', '?before=2026-01-03T00:00:00Z']) {
      const messages = await get(`/conversations/${id}/messages${suffix}`);
      expect(messages.status).toBe(200);
      expect(messages.body.messages).toHaveLength(2);
      for (const message of messages.body.messages) expectPrivateUser(message.sender);
      expect(messages.body.messages[1].replyTo).toMatchObject({ id: `${prefix}-old`, senderId: alice });
      expectPrivateUser(messages.body.messages[1].replyTo.sender);
    }
  });

  it.each([[alice, bob], [bob, alice]])('refuses creation when %s blocks %s', async (blocker, blocked) => {
    await query('MATCH (a:User {id: $blocker}), (b:User {id: $blocked}) CREATE (a)-[:BLOCKED]->(b)', { blocker, blocked });
    try {
      await expect(ensureDirectConversation(alice, bob)).rejects.toBeInstanceOf(DirectConversationNotAllowedError);
      const hidden = await query(CONVERSATIONS_QUERY, { userId: blocked });
      expect(hidden.records).toEqual([]);
    } finally {
      await query('MATCH (:User {id: $blocker})-[r:BLOCKED]->(:User {id: $blocked}) DELETE r', { blocker, blocked });
    }
  });
});
