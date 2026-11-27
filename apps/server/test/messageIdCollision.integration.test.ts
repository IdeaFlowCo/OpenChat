import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// openchat-dkv: a client-chosen message id is only a retry key for the same
// sender in the same conversation. Offering the id of someone else's message
// used to return that message (from a chat the caller is not in), broadcast it
// into the caller's chat and link it there. Real socket, real route, real Neo4j.
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

const JWT_SECRET = 'message-id-collision-test-secret';

integration('a client-chosen message id cannot address another message', () => {
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const malloryId = `mallory-${suffix}`, bobId = `bob-${suffix}`, carolId = `carol-${suffix}`;
  const sharedId = `conv-shared-${suffix}`, privateId = `conv-private-${suffix}`;
  const secretId = `secret-${suffix}`, bobSharedId = `bobshared-${suffix}`;
  const SECRET = 'SECRET-CANARY only Bob and Carol may read this';

  let driver: Driver; let httpServer: HttpServer; let io: IOServer; let mallory: ClientSocket; let bob: ClientSocket;
  const bobSaw: Array<Record<string, any>> = [];
  const token = (userId: string) => jwt.sign({ userId, email: `${userId}@example.test` }, JWT_SECRET);
  const connect = (userId: string) => new Promise<ClientSocket>((resolve, reject) => {
    const address = httpServer.address(); const port = typeof address === 'object' && address ? address.port : 0;
    const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: token(userId) }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket)); socket.on('connect_error', reject);
  });
  const send = (socket: ClientSocket, payload: Record<string, unknown>) => new Promise<Record<string, any>>(resolve => {
    socket.emit('message:send', payload, (ack: Record<string, any>) => resolve(ack));
  });
  const post = (who: string, conversationId: string, body: Record<string, unknown>) =>
    request(httpServer).post(`/api/chat/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${token(who)}`).send(body);
  const run = async (query: string, params: Record<string, unknown> = {}) => { const s = driver.session(); try { return await s.run(query, params); } finally { await s.close(); } };
  const secretState = async () => {
    const r = await run(`MATCH (m:Message {id:$id}) RETURN m.content AS content, m.senderId AS senderId, m.conversationId AS conversationId,
      [(m)-[:IN_CONVERSATION]->(c) | c.id] AS chats, [(u)-[:SENT]->(m) | u.id] AS senders`, { id: secretId });
    const row = r.records[0]!;
    return { content: row.get('content'), senderId: row.get('senderId'), conversationId: row.get('conversationId'), chats: row.get('chats'), senders: row.get('senders') };
  };
  const untouched = { content: SECRET, senderId: bobId, conversationId: privateId, chats: [privateId], senders: [bobId] };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!; process.env.JWT_SECRET = JWT_SECRET;
    const database = await import('../src/db.js');
    const { setupChatSocket } = await import('../src/websocket/chatHandler.js');
    const { default: chatRouter } = await import('../src/routes/chat.js');
    await database.initDatabase();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    await run(`
      CREATE (mallory:User {id:$malloryId, name:'Mallory Synthetic', email:$malloryId + '@example.test'})
      CREATE (bob:User {id:$bobId, name:'Bob Synthetic', email:$bobId + '@example.test'})
      CREATE (carol:User {id:$carolId, name:'Carol Synthetic', email:$carolId + '@example.test'})
      CREATE (shared:Conversation {id:$sharedId, type:'direct', createdAt:datetime()})
      CREATE (private:Conversation {id:$privateId, type:'direct', createdAt:datetime()})
      CREATE (mallory)-[:PARTICIPATES_IN]->(shared)<-[:PARTICIPATES_IN]-(bob)
      CREATE (bob)-[:PARTICIPATES_IN]->(private)<-[:PARTICIPATES_IN]-(carol)
      CREATE (bob)-[:SENT]->(:Message {id:$secretId, content:$secret, senderId:$bobId, conversationId:$privateId, messageType:'text', createdAt:datetime()})-[:IN_CONVERSATION]->(private)
      CREATE (bob)-[:SENT]->(:Message {id:$bobSharedId, content:'Bob in the shared chat', senderId:$bobId, conversationId:$sharedId, messageType:'text', createdAt:datetime()})-[:IN_CONVERSATION]->(shared)
    `, { malloryId, bobId, carolId, sharedId, privateId, secretId, bobSharedId, secret: SECRET });
    const app = express().use(express.json());
    httpServer = createServer(app);
    io = new IOServer(httpServer);
    app.set('io', io);
    app.use('/api/chat', chatRouter);
    setupChatSocket(io);
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    mallory = await connect(malloryId); bob = await connect(bobId);
    bob.on('message:new', (m: Record<string, any>) => bobSaw.push(m));
  }, 120000);

  afterAll(async () => {
    // Sends start best-effort background work (mentions, embeddings, agents); let it finish before the pool closes.
    await new Promise(resolve => setTimeout(resolve, 1500));
    mallory?.disconnect(); bob?.disconnect(); io?.close();
    await new Promise<void>(resolve => { httpServer ? httpServer.close(() => resolve()) : resolve(); });
    if (!driver) return;
    await run('MATCH (m:Message) WHERE m.conversationId IN $chats DETACH DELETE m', { chats: [sharedId, privateId] });
    await run('MATCH (n) WHERE n.id IN $ids DETACH DELETE n', { ids: [malloryId, bobId, carolId, sharedId, privateId] });
    await driver.close();
    await (await import('../src/db.js')).closeDatabase();
  });

  it('socket: offering the id of a message in a chat you are not in returns nothing and changes nothing', async () => {
    const ack = await send(mallory, { conversationId: sharedId, content: 'probe', id: secretId });
    expect(ack).toEqual({ error: 'Message id already in use' });
    expect(JSON.stringify(ack)).not.toContain('SECRET-CANARY');
    expect(await secretState()).toEqual(untouched);
  });

  it('socket: offering the id of someone else’s message in your own chat is refused too', async () => {
    const ack = await send(mallory, { conversationId: sharedId, content: 'probe', id: bobSharedId });
    expect(ack).toEqual({ error: 'Message id already in use' });
    const r = await run('MATCH (u)-[:SENT]->(m:Message {id:$id}) RETURN collect(u.id) AS senders, m.content AS content', { id: bobSharedId });
    expect(r.records[0]!.get('senders')).toEqual([bobId]);
    expect(r.records[0]!.get('content')).toBe('Bob in the shared chat');
  });

  it('REST: the same two collisions answer 409 without the other message', async () => {
    for (const id of [secretId, bobSharedId]) {
      const res = await post(malloryId, sharedId, { content: 'probe', id });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Message id already in use' });
    }
    expect(await secretState()).toEqual(untouched);
  });

  it('nothing from the refused sends reached the other participant or the chat preview', async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(bobSaw).toEqual([]);
    const r = await run('MATCH (c:Conversation {id:$id}) RETURN c.lastMessagePreview AS preview, c.updatedAt AS updatedAt, c.lastMessageAt AS lastMessageAt, COUNT { (:Message)-[:IN_CONVERSATION]->(c) } AS linked', { id: sharedId });
    expect(r.records[0]!.get('preview')).toBeNull();
    expect(r.records[0]!.get('updatedAt')).toBeNull();
    expect(r.records[0]!.get('lastMessageAt')).toBeNull();
    expect(r.records[0]!.get('linked').toNumber()).toBe(1);
  });

  it('malformed and reserved ids are refused before anything is stored', async () => {
    for (const id of ['x'.repeat(65), 'has space in it', `ocu_${'a'.repeat(40)}`, `ocd_${'a'.repeat(40)}`, 12345678]) {
      expect((await send(mallory, { conversationId: sharedId, content: 'probe', id })).error, String(id)).toMatch(/^Message id must be/);
      expect((await post(malloryId, sharedId, { content: 'probe', id })).status, String(id)).toBe(400);
    }
    const r = await run('MATCH (m:Message {conversationId:$id, senderId:$mallory}) RETURN count(m) AS n', { id: sharedId, mallory: malloryId });
    expect(r.records[0]!.get('n').toNumber()).toBe(0);
  });

  it('a retry with your own id still collapses to one message, across socket and REST', async () => {
    const id = `retry-${suffix}-0001`;
    const first = await send(mallory, { conversationId: sharedId, content: 'Synthetic: hello once', id });
    expect(first.success).toBe(true);
    expect(first.message).toMatchObject({ id, content: 'Synthetic: hello once', senderId: malloryId, conversationId: sharedId });
    const again = await send(mallory, { conversationId: sharedId, content: 'Synthetic: hello once', id });
    expect(again.message).toMatchObject({ id, content: 'Synthetic: hello once' });
    const viaRest = await post(malloryId, sharedId, { content: 'Synthetic: hello once', id });
    expect(viaRest.status).toBeLessThan(300);
    expect(viaRest.body).toMatchObject({ id, content: 'Synthetic: hello once' });
    const r = await run('MATCH (m:Message {id:$id}) RETURN count(m) AS n', { id });
    expect(r.records[0]!.get('n').toNumber()).toBe(1);
    // Positive control for the refusals above: Bob's listener is live and saw this real message.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(bobSaw.some(m => m.id === id && m.content === 'Synthetic: hello once')).toBe(true);
    expect(JSON.stringify(bobSaw)).not.toContain('SECRET-CANARY');
    // A late retry of an older send does not put its text back in the chat preview.
    const newer = await send(mallory, { conversationId: sharedId, content: 'Synthetic: the newer message', id: `newer-${suffix}-0003` });
    expect(newer.success).toBe(true);
    await send(mallory, { conversationId: sharedId, content: 'Synthetic: hello once', id });
    const preview = await run('MATCH (c:Conversation {id:$id}) RETURN c.lastMessagePreview AS preview', { id: sharedId });
    expect(preview.records[0]!.get('preview')).toBe('Synthetic: the newer message');
    // Your own id from another chat is not a retry here: it must not move or relink the message.
    const elsewhere = `own-${suffix}-0002`;
    await run(`MATCH (b:User {id:$bobId}), (p:Conversation {id:$privateId})
      CREATE (b)-[:SENT]->(:Message {id:$elsewhere, content:'Bob elsewhere', senderId:$bobId, conversationId:$privateId, messageType:'text', createdAt:datetime()})-[:IN_CONVERSATION]->(p)`, { bobId, privateId, elsewhere });
    expect(await send(bob, { conversationId: sharedId, content: 'Bob elsewhere', id: elsewhere })).toEqual({ error: 'Message id already in use' });
    const links = await run('MATCH (m:Message {id:$id})-[:IN_CONVERSATION]->(c) RETURN collect(c.id) AS chats', { id: elsewhere });
    expect(links.records[0]!.get('chats')).toEqual([privateId]);
  });

  it('a send without an id gets a server id', async () => {
    const ack = await send(mallory, { conversationId: sharedId, content: 'Synthetic: no id' });
    expect(ack.success).toBe(true);
    expect(String(ack.message.id)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const res = await post(malloryId, sharedId, { content: 'Synthetic: no id over REST' });
    expect(res.status).toBeLessThan(300);
    expect(String(res.body.id)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
