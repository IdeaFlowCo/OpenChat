import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';

// Reproduction for the socket reply bug (scout report §2.3): the REST message
// route persisted `replyToId` and hydrated `replyTo`, but the `message:send`
// socket handler — the PRIMARY path for both clients — neither accepted nor
// wrote it, so on mobile a threaded reply silently persisted as an ordinary
// message. This test drives a real socket against a real Neo4j.
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

const JWT_SECRET = 'socket-reply-test-secret';

integration('message:send replyToId', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const aliceId = `alice-${suffix}`;
  const bobId = `bob-${suffix}`;
  const conversationId = `conv-${suffix}`;
  const otherConversationId = `conv-other-${suffix}`;
  const bobMessageId = `msg-bob-${suffix}`;
  const foreignMessageId = `msg-foreign-${suffix}`;

  let driver: Driver;
  let httpServer: HttpServer;
  let io: IOServer;
  let client: ClientSocket;

  const connect = (userId: string, email: string) => new Promise<ClientSocket>((resolve, reject) => {
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const token = jwt.sign({ userId, email }, JWT_SECRET);
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });

  const send = (payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    client.emit('message:send', payload, (ack: Record<string, unknown>) => resolve(ack));
  });

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    process.env.JWT_SECRET = JWT_SECRET;

    const database = await import('../src/db.js');
    const { setupChatSocket } = await import('../src/websocket/chatHandler.js');
    await database.initDatabase();

    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      // Alice and Bob share a conversation; Bob has already said something.
      // A second conversation holds a message Alice must NOT be able to quote.
      await session.run(
        `
        CREATE (alice:User {id: $aliceId, name: 'Alice', email: $aliceEmail})
        CREATE (bob:User {id: $bobId, name: 'Bob', email: $bobEmail})
        CREATE (c:Conversation {id: $conversationId, type: 'direct', createdAt: datetime()})
        CREATE (alice)-[:PARTICIPATES_IN]->(c)
        CREATE (bob)-[:PARTICIPATES_IN]->(c)
        CREATE (bobMsg:Message {
          id: $bobMessageId, content: 'We should talk about the new role',
          senderId: $bobId, conversationId: $conversationId,
          messageType: 'text', createdAt: datetime()
        })
        CREATE (bobMsg)-[:IN_CONVERSATION]->(c)
        CREATE (bob)-[:SENT]->(bobMsg)
        CREATE (other:Conversation {id: $otherConversationId, type: 'direct', createdAt: datetime()})
        CREATE (bob)-[:PARTICIPATES_IN]->(other)
        CREATE (foreign:Message {
          id: $foreignMessageId, content: 'private elsewhere',
          senderId: $bobId, conversationId: $otherConversationId,
          messageType: 'text', createdAt: datetime()
        })
        CREATE (foreign)-[:IN_CONVERSATION]->(other)
        `,
        {
          aliceId, bobId, conversationId, otherConversationId,
          bobMessageId, foreignMessageId,
          aliceEmail: `${aliceId}@example.test`,
          bobEmail: `${bobId}@example.test`,
        },
      );
    } finally {
      await session.close();
    }

    httpServer = createServer();
    io = new IOServer(httpServer);
    setupChatSocket(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    client = await connect(aliceId, `${aliceId}@example.test`);
  });

  afterAll(async () => {
    client?.disconnect();
    io?.close();
    await new Promise<void>((resolve) => { httpServer ? httpServer.close(() => resolve()) : resolve(); });
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run(
        `
        MATCH (u:User) WHERE u.id IN $userIds
        OPTIONAL MATCH (u)-[:HAS_THOUGHT]->(t:Thought)
        DETACH DELETE t, u
        `,
        { userIds: [aliceId, bobId] },
      );
      await session.run(
        `MATCH (c:Conversation) WHERE c.id IN $conversationIds
         OPTIONAL MATCH (m:Message)-[:IN_CONVERSATION]->(c)
         DETACH DELETE m, c`,
        { conversationIds: [conversationId, otherConversationId] },
      );
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('persists replyToId and acks a hydrated replyTo', async () => {
    const replyId = `msg-reply-${suffix}`;
    const ack = await send({
      conversationId,
      content: 'Yes, let us',
      id: replyId,
      replyToId: bobMessageId,
    });

    expect(ack.error).toBeUndefined();
    expect(ack.success).toBe(true);

    const message = ack.message as Record<string, unknown>;
    expect(message.replyToId).toBe(bobMessageId);
    expect(message.replyTo).toMatchObject({
      id: bobMessageId,
      senderId: bobId,
      senderName: 'Bob',
      content: 'We should talk about the new role',
    });

    const session = driver.session();
    try {
      const result = await session.run(
        'MATCH (m:Message {id: $replyId}) RETURN m.replyToId AS replyToId',
        { replyId },
      );
      expect(result.records[0]?.get('replyToId')).toBe(bobMessageId);
    } finally {
      await session.close();
    }
  });

  it('acks replyTo as null for an ordinary message', async () => {
    const ack = await send({
      conversationId,
      content: 'unrelated',
      id: `msg-plain-${suffix}`,
    });

    expect(ack.success).toBe(true);
    expect((ack.message as Record<string, unknown>).replyTo).toBeNull();
  });

  it('rejects a replyToId from another conversation', async () => {
    const ack = await send({
      conversationId,
      content: 'leak attempt',
      id: `msg-leak-${suffix}`,
      replyToId: foreignMessageId,
    });

    expect(ack.error).toBe('replyToId does not point to a message in this conversation');

    const session = driver.session();
    try {
      const result = await session.run(
        'MATCH (m:Message {id: $id}) RETURN m',
        { id: `msg-leak-${suffix}` },
      );
      expect(result.records).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});
