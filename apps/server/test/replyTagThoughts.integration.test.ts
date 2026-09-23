import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver, type Session } from 'neo4j-driver';

// Reply-aware hashtag capture (scout report §5 step 1). Replying "#hiring" to
// Bob's message is an act of tagging BOB'S message — the Thought must hang off
// the parent, not off the one-word reply that carried the tag. Before this,
// createThoughtsFromMessageTags was reply-blind and produced a Thought about
// the reply, the inverse of NoteStream Vision's tag-as-capture semantics.
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('reply-aware hashtag capture', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const aliceId = `alice-${suffix}`;
  const bobId = `bob-${suffix}`;
  const conversationId = `conv-${suffix}`;
  const bobMessageId = `msg-bob-${suffix}`;
  const BOB_TEXT = 'We should bring on another backend engineer';

  let driver: Driver;
  let extract: typeof import('../src/services/extractThoughtsFromMessage.js');

  const withSession = async <T>(fn: (session: Session) => Promise<T>): Promise<T> => {
    const session = driver.session();
    try { return await fn(session); } finally { await session.close(); }
  };

  // Persist a reply from Alice, then run the tag extractor exactly as the send
  // paths do.
  const replyWithTag = async (replyId: string, content: string) => {
    await withSession((session) => session.run(
      `
      MATCH (alice:User {id: $aliceId})
      MATCH (c:Conversation {id: $conversationId})
      CREATE (m:Message {
        id: $replyId, content: $content, senderId: $aliceId,
        conversationId: $conversationId, messageType: 'text',
        replyToId: $bobMessageId, createdAt: datetime()
      })
      CREATE (m)-[:IN_CONVERSATION]->(c)
      CREATE (alice)-[:SENT]->(m)
      `,
      { aliceId, conversationId, replyId, content, bobMessageId },
    ));
    return withSession((session) => extract.createThoughtsFromMessageTags(session, {
      senderId: aliceId,
      messageId: replyId,
      conversationId,
      content,
      replyToId: bobMessageId,
    }));
  };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    const database = await import('../src/db.js');
    extract = await import('../src/services/extractThoughtsFromMessage.js');
    await database.initDatabase();

    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    await withSession((session) => session.run(
      `
      CREATE (alice:User {id: $aliceId, name: 'Alice', email: $aliceEmail})
      CREATE (bob:User {id: $bobId, name: 'Bob', email: $bobEmail})
      CREATE (c:Conversation {id: $conversationId, type: 'group', createdAt: datetime()})
      CREATE (alice)-[:PARTICIPATES_IN]->(c)
      CREATE (bob)-[:PARTICIPATES_IN]->(c)
      CREATE (bobMsg:Message {
        id: $bobMessageId, content: $bobText, senderId: $bobId,
        conversationId: $conversationId, messageType: 'text', createdAt: datetime()
      })
      CREATE (bobMsg)-[:IN_CONVERSATION]->(c)
      CREATE (bob)-[:SENT]->(bobMsg)
      `,
      {
        aliceId, bobId, conversationId, bobMessageId, bobText: BOB_TEXT,
        aliceEmail: `${aliceId}@example.test`,
        bobEmail: `${bobId}@example.test`,
      },
    ));
  });

  afterAll(async () => {
    if (!driver) return;
    await withSession((session) => session.run(
      `
      MATCH (u:User) WHERE u.id IN $userIds
      OPTIONAL MATCH (u)-[:HAS_THOUGHT]->(t:Thought)
      DETACH DELETE t, u
      `,
      { userIds: [aliceId, bobId] },
    ));
    await withSession((session) => session.run(
      `MATCH (c:Conversation {id: $conversationId})
       OPTIONAL MATCH (m:Message)-[:IN_CONVERSATION]->(c)
       DETACH DELETE m, c`,
      { conversationId },
    ));
    await driver.close();
  });

  it('extracts hyphenated and non-ASCII tags whole', () => {
    expect(extract.extractTagsFromMessage('#q4-goals').map((t) => t.name)).toEqual(['q4-goals']);
    expect(extract.extractTagsFromMessage('#embauche_été').map((t) => t.name)).toEqual(['embauche_été']);
  });

  it('links the Thought to the PARENT message with reply-tag provenance', async () => {
    const replyId = `msg-reply-${suffix}`;
    const [thoughtId] = await replyWithTag(replyId, '#hiring');
    expect(thoughtId).toBeTruthy();

    const record = await withSession(async (session) => {
      const result = await session.run(
        `MATCH (t:Thought {id: $thoughtId})-[:FROM_MESSAGE]->(m:Message)
         RETURN m.id AS sourceMessageId, t.captureMethod AS captureMethod,
                t.viaMessageId AS viaMessageId, t.text AS text, t.tags AS tags,
                t.userId AS ownerId`,
        { thoughtId },
      );
      return result.records[0];
    });

    // The Thought is about BOB's message, carries BOB's text, and records the
    // reply that caused it — while remaining owned by the tagger.
    expect(record?.get('sourceMessageId')).toBe(bobMessageId);
    expect(record?.get('captureMethod')).toBe('reply-tag');
    expect(record?.get('viaMessageId')).toBe(replyId);
    expect(record?.get('text')).toBe(BOB_TEXT);
    expect(record?.get('tags')).toEqual(['hiring']);
    expect(record?.get('ownerId')).toBe(aliceId);
  });

  it('is visible to every participant in the conversation thoughts view', async () => {
    const replyId = `msg-reply-visible-${suffix}`;
    const [thoughtId] = await replyWithTag(replyId, '#decision');

    // Mirrors the `fromChat` predicate in routes/thoughts.ts, asked as BOB —
    // who neither owns the Thought nor sent the tagging reply.
    const ids = await withSession(async (session) => {
      const result = await session.run(
        `
        MATCH (t:Thought)-[:FROM_MESSAGE]->(m:Message {conversationId: $conversationId})
        WHERE (t.userId = $userId
               OR t.captureMethod IN ['inline-tag', 'reply-tag']
               OR size(coalesce(t.tags, [])) > 0)
          AND NOT (t)-[:PINNED_IN]->(:Conversation {id: $conversationId})
        RETURN t.id AS id
        `,
        { userId: bobId, conversationId },
      );
      return result.records.map((r) => r.get('id') as string);
    });

    expect(ids).toContain(thoughtId);
  });

  it('withdraws the Thought when the tagging reply is deleted', async () => {
    const replyId = `msg-reply-deleted-${suffix}`;
    const [thoughtId] = await replyWithTag(replyId, '#reminder');

    // The cleanup the DELETE /messages/:id route runs.
    await withSession((session) => session.run(
      `MATCH (t:Thought {viaMessageId: $messageId, captureMethod: 'reply-tag'}) DETACH DELETE t`,
      { messageId: replyId },
    ));

    const remaining = await withSession(async (session) => {
      const result = await session.run('MATCH (t:Thought {id: $thoughtId}) RETURN t', { thoughtId });
      return result.records.length;
    });
    expect(remaining).toBe(0);
  });

  it('still tags the carrying message when there is no reply parent', async () => {
    const messageId = `msg-inline-${suffix}`;
    await withSession((session) => session.run(
      `
      MATCH (alice:User {id: $aliceId})
      MATCH (c:Conversation {id: $conversationId})
      CREATE (m:Message {
        id: $messageId, content: $content, senderId: $aliceId,
        conversationId: $conversationId, messageType: 'text', createdAt: datetime()
      })
      CREATE (m)-[:IN_CONVERSATION]->(c)
      CREATE (alice)-[:SENT]->(m)
      `,
      { aliceId, conversationId, messageId, content: '#fact standups are at 10' },
    ));
    const [thoughtId] = await withSession((session) => extract.createThoughtsFromMessageTags(session, {
      senderId: aliceId,
      messageId,
      conversationId,
      content: '#fact standups are at 10',
    }));

    const record = await withSession(async (session) => {
      const result = await session.run(
        `MATCH (t:Thought {id: $thoughtId})-[:FROM_MESSAGE]->(m:Message)
         RETURN m.id AS sourceMessageId, t.captureMethod AS captureMethod, t.viaMessageId AS viaMessageId`,
        { thoughtId },
      );
      return result.records[0];
    });
    expect(record?.get('sourceMessageId')).toBe(messageId);
    expect(record?.get('captureMethod')).toBe('inline-tag');
    expect(record?.get('viaMessageId')).toBeNull();
  });
});
