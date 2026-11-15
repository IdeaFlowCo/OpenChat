import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import express from 'express';
import neo4j from 'neo4j-driver';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

const state = vi.hoisted(() => ({ driver: null as any, push: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));
vi.mock('../src/services/push.js', () => ({ sendPushToUser: state.push }));
import groupRouter from '../src/routes/unlinkedGroups.js';
import chatRouter from '../src/routes/chat.js';
import { ensureSharedInbox } from '../src/services/unlinkedMessaging.js';
import { setupChatSocket } from '../src/websocket/chatHandler.js';

const prefix = `community-acceptance-${randomUUID()}`, groupId = randomUUID();
const secret = 'synthetic-acceptance-secret-'.repeat(3);
const person = (name: string) => ({ issuer: 'https://id.ideaflow.app/api/auth', subject: `${prefix}-${name}`, name });
const body = { groupId, revision: 1, name: 'Synthetic community', organizer: person('Owner'), members: [person('Member')], deleted: false };
const app = express().use(express.json()).use('/api', groupRouter).use('/api/chat', chatRouter);
const http = createServer(app), io = new Server(http), sockets: Socket[] = [];
const transcript: Array<{ step: string; output: unknown }> = [];
let conversationId: string;
const q = async (query: string, params = {}) => {
  const session = state.driver.session();
  try { return await session.run(query, params); } finally { await session.close(); }
};
const auth = (id: string) => jwt.sign({ userId: id, email: 'synthetic@example.test' }, secret);
const sync = (snapshot: unknown) => request(app).post('/api/unlinked/groups/sync').auth(secret, { type: 'bearer' }).send(snapshot);
const record = (step: string, output: unknown) => transcript.push({ step, output });
const suite = process.env.NEO4J_TEST_URI ? describe : describe.skip;

suite('community roster end-user acceptance', () => {
  beforeAll(async () => {
    state.driver = neo4j.driver(process.env.NEO4J_TEST_URI!, neo4j.auth.basic(process.env.NEO4J_TEST_USER ?? 'neo4j', process.env.NEO4J_TEST_PASSWORD!));
    vi.stubEnv('UNLINKED_MESSAGING_SECRET', secret); vi.stubEnv('JWT_SECRET', secret);
    for (const query of [
      'CREATE CONSTRAINT community_identity IF NOT EXISTS FOR(u:User) REQUIRE u.ideaflowIdentityKey IS UNIQUE',
      'CREATE CONSTRAINT community_sync IF NOT EXISTS FOR(s:UnlinkedGroupSync) REQUIRE s.groupId IS UNIQUE',
      'CREATE CONSTRAINT community_conversation IF NOT EXISTS FOR(c:Conversation) REQUIRE c.id IS UNIQUE',
    ]) await q(query);
    setupChatSocket(io); app.set('io', io);
    io.on('connection', socket => socket.on('test:barrier', ack => ack()));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>(resolve => io.close(() => resolve()));
    await q('MATCH(m:Message {conversationId:$id}) DETACH DELETE m', { id: conversationId ?? '' });
    await q('MATCH(c:Conversation {id:$id}) OPTIONAL MATCH(c)-[:HAS_INVITE]->(i:GroupInvite) DETACH DELETE c,i', { id: conversationId ?? '' });
    await q('MATCH(s:UnlinkedGroupSync {groupId:$groupId}) DELETE s', { groupId });
    await q('MATCH(u:User) WHERE u.ideaflowSub STARTS WITH $prefix DETACH DELETE u', { prefix });
    await state.driver.close(); vi.unstubAllEnvs();
  });
  it('migrates history, discovers the normal inbox, retains settings, revokes access and produces no sync messages or pushes', async () => {
    const owner = await ensureSharedInbox(body.organizer, body.organizer.name);
    const member = await ensureSharedInbox(body.members[0], body.members[0].name);
    const created = await request(app).post('/api/chat/conversations').auth(auth(owner.id), { type: 'bearer' })
      .send({ type: 'group', title: 'Existing history', participantIds: [member.id] });
    expect(created.status, created.text).toBe(201); conversationId = created.body.id;
    const messageId = randomUUID();
    await q(`MATCH(c:Conversation {id:$id}),(u:User {id:$owner})
      CREATE(m:Message {id:$messageId,conversationId:$id,senderId:$owner,content:'Preserved community history',messageType:'text',createdAt:datetime()})
      CREATE(m)-[:IN_CONVERSATION]->(c) CREATE(u)-[:SENT]->(m)`, { id: conversationId, owner: owner.id, messageId });
    const mute = await request(app).patch(`/api/chat/conversations/${conversationId}/participants/me`)
      .auth(auth(member.id), { type: 'bearer' }).send({ mutedUntil: 'always' });
    expect(mute.status).toBe(200);
    const events: Array<{ type: string; data: any }> = [];
    const socket = connect(`http://127.0.0.1:${(http.address() as { port: number }).port}`, { auth: { token: auth(member.id) }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    socket.onAny((type, data) => events.push({ type, data }));
    const flush = () => socket.timeout(3000).emitWithAck('test:barrier');
    const snapshot = { ...body, existingConversationId: conversationId };
    const injection = await request(app).post('/api/unlinked/groups/sync').auth(auth(member.id), { type: 'bearer' }).send(snapshot);
    expect(injection.status).toBe(401); record('Ordinary member cannot inject a roster', { status: injection.status, body: injection.body });
    const syncResult = await sync(snapshot);
    expect(syncResult.status, syncResult.text).toBe(200); expect(syncResult.body.conversationId).toBe(conversationId);
    record('Owner-verified migration retains the original conversation ID', { status: syncResult.status, body: syncResult.body });
    await flush();
    const discovery = events.find(e => e.type === 'conversation:created');
    expect(discovery?.data.conversation.participants).toHaveLength(2);
    record('Connected member receives ordinary inbox discovery', discovery);
    for (const user of [owner, member]) {
      const inbox = await request(app).get('/api/chat/conversations').auth(auth(user.id), { type: 'bearer' });
      expect(inbox.status).toBe(200);
      const conversation = inbox.body.find((c: any) => c.id === conversationId);
      expect(conversation).toBeDefined(); record(`${user.name} normal inbox`, conversation);
    }
    const history = await request(app).get(`/api/chat/conversations/${conversationId}/messages`).auth(auth(member.id), { type: 'bearer' });
    expect(history.status).toBe(200); expect(history.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, content: 'Preserved community history' })]));
    record('Migrated member can still read existing messages', { status: history.status, body: history.body });
    const retained = await q('MATCH(:User {id:$member})-[p:PARTICIPATES_IN]->(:Conversation {id:$id}) RETURN p.mutedUntil AS mutedUntil', { member: member.id, id: conversationId });
    expect(retained.records[0].get('mutedUntil')).toBe('always'); record('Migration retains member mute setting', retained.records[0].toObject());
    const denied = await request(app).delete(`/api/chat/conversations/${conversationId}/participants/${member.id}`).auth(auth(member.id), { type: 'bearer' });
    expect(denied.status).toBe(409); record('Managed chat directs membership changes to Unlinked', { status: denied.status, body: denied.body });
    const removal = await sync({ ...snapshot, revision: 2, members: [] }); expect(removal.status).toBe(200); await flush();
    record('Removal socket event', events.find(e => e.type === 'participant:removed'));
    expect(events.some(e => e.type === 'participant:removed' && e.data.userId === member.id)).toBe(true);
    const removedInbox = await request(app).get('/api/chat/conversations').auth(auth(member.id), { type: 'bearer' });
    expect(removedInbox.status).toBe(200); expect(removedInbox.body.some((c: any) => c.id === conversationId)).toBe(false);
    record('Removed member normal inbox', removedInbox.body);
    const forbidden = await request(app).get(`/api/chat/conversations/${conversationId}/messages`).auth(auth(member.id), { type: 'bearer' });
    expect(forbidden.status).toBe(404); record('Removed member cannot read history', { status: forbidden.status, body: forbidden.body });
    const stale = await sync(snapshot); expect(stale.status).toBe(409); record('Old roster cannot restore access', { status: stale.status, body: stale.body });
    expect((await sync({ ...snapshot, revision: 3, members: [], deleted: true })).status).toBe(200);
    const persisted = await q(`MATCH(c:Conversation {id:$id}) MATCH(s:UnlinkedGroupSync {groupId:$groupId})
      RETURN c.id AS conversationId,s.revision AS revision,s.deleted AS deleted,
      COUNT { MATCH(:User)-[:PARTICIPATES_IN]->(c) } AS participantCount,
      COUNT { MATCH(m:Message {conversationId:$id}) } AS messageCount`, { id: conversationId, groupId });
    const row = persisted.records[0];
    expect(Number(row.get('participantCount'))).toBe(0); expect(Number(row.get('messageCount'))).toBe(1); expect(row.get('deleted')).toBe(true);
    record('Deletion tombstone preserves history without generating messages', { conversationId, revision: Number(row.get('revision')), deleted: row.get('deleted'), participantCount: Number(row.get('participantCount')), messageCount: Number(row.get('messageCount')) });
    expect(state.push).not.toHaveBeenCalled(); expect(events.filter(e => e.type.startsWith('message:'))).toEqual([]);
    record('Roster synchronization is silent', { pushCalls: state.push.mock.calls.length, messageEvents: events.filter(e => e.type.startsWith('message:')) });
    if (process.env.COMMUNITY_TEST_EVIDENCE_PATH) await writeFile(process.env.COMMUNITY_TEST_EVIDENCE_PATH, JSON.stringify({ fixture: 'Synthetic isolated HTTP + Neo4j + Socket.IO, no production data', transcript }, null, 2));
  });
});
