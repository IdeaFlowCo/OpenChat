import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { CONVERSATIONS_QUERY, UNREAD_TOTAL_QUERY } from '../src/queries/chatUnread.js';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('server-side unread tracking', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const aliceId = `unread-alice-${suffix}`;
  const bobId = `unread-bob-${suffix}`;
  const conversationId = `unread-conversation-${suffix}`;
  let driver: Driver;

  beforeAll(async () => {
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run(`
        CREATE (alice:User {id: $aliceId, name: 'Unread Alice', email: $aliceEmail})
        CREATE (bob:User {id: $bobId, name: 'Unread Bob', email: $bobEmail})
        CREATE (conversation:Conversation {
          id: $conversationId,
          type: 'direct',
          lastMessageAt: datetime('2026-01-02T04:00:00Z')
        })
        CREATE (alice)-[:PARTICIPATES_IN {
          role: 'member',
          lastReadAt: datetime('2026-01-01T00:00:00Z')
        }]->(conversation)
        CREATE (bob)-[:PARTICIPATES_IN {role: 'member'}]->(conversation)
        CREATE (unread:Message {
          id: $unreadId,
          conversationId: $conversationId,
          senderId: $bobId,
          content: 'new from Bob',
          createdAt: datetime('2026-01-02T01:00:00Z')
        })-[:IN_CONVERSATION]->(conversation)
        CREATE (own:Message {
          id: $ownId,
          conversationId: $conversationId,
          senderId: $aliceId,
          content: 'new from Alice',
          createdAt: datetime('2026-01-02T02:00:00Z')
        })-[:IN_CONVERSATION]->(conversation)
        CREATE (deleted:Message {
          id: $deletedId,
          conversationId: $conversationId,
          senderId: $bobId,
          content: 'Message deleted',
          createdAt: datetime('2026-01-02T03:00:00Z'),
          deletedAt: datetime('2026-01-02T03:30:00Z')
        })-[:IN_CONVERSATION]->(conversation)
        CREATE (old:Message {
          id: $oldId,
          conversationId: $conversationId,
          senderId: $bobId,
          content: 'already read',
          createdAt: datetime('2025-12-31T23:00:00Z')
        })-[:IN_CONVERSATION]->(conversation)
      `, {
        aliceId,
        aliceEmail: `${aliceId}@example.test`,
        bobId,
        bobEmail: `${bobId}@example.test`,
        conversationId,
        unreadId: `unread-message-${suffix}`,
        ownId: `own-message-${suffix}`,
        deletedId: `deleted-message-${suffix}`,
        oldId: `old-message-${suffix}`,
      });
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run(`
        MATCH (conversation:Conversation {id: $conversationId})
        OPTIONAL MATCH (message:Message {conversationId: $conversationId})
        DETACH DELETE message, conversation
      `, { conversationId });
      await session.run(
        'MATCH (user:User) WHERE user.id IN [$aliceId, $bobId] DETACH DELETE user',
        { aliceId, bobId },
      );
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('returns lastReadAt and counts only new messages from the other party', async () => {
    const session = driver.session();
    try {
      const result = await session.run(CONVERSATIONS_QUERY, { userId: aliceId });
      const conversation = result.records[0].get('conversation');

      expect(conversation.lastReadAt.toString()).toBe('2026-01-01T00:00:00Z');
      expect(conversation.unreadCount.toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('returns the same filtered count from unread-total', async () => {
    const session = driver.session();
    try {
      const result = await session.run(UNREAD_TOTAL_QUERY, { userId: aliceId });
      expect(result.records[0].get('unreadTotal').toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('returns zero after the conversation is marked read', async () => {
    const session = driver.session();
    try {
      await session.run(`
        MATCH (:User {id: $userId})-[rel:PARTICIPATES_IN]->(:Conversation {id: $conversationId})
        SET rel.lastReadAt = datetime($now)
      `, {
        userId: aliceId,
        conversationId,
        now: '2026-01-02T05:00:00Z',
      });

      const listResult = await session.run(CONVERSATIONS_QUERY, { userId: aliceId });
      const totalResult = await session.run(UNREAD_TOTAL_QUERY, { userId: aliceId });
      expect(listResult.records[0].get('conversation').unreadCount.toNumber()).toBe(0);
      expect(totalResult.records[0].get('unreadTotal').toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });
});
