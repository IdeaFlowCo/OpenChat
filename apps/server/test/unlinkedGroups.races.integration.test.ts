import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import neo4j from 'neo4j-driver';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
const state = vi.hoisted(() => ({ driver: null as any }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));
import router from '../src/routes/unlinkedGroups.js';
import chatRouter from '../src/routes/chat.js';
import * as chat from '../src/routes/chat.js';
import * as groups from '../src/services/unlinkedGroups.js';
import * as invites from '../src/services/inviteEntry.js';
import { publishConversationEvent } from '../src/services/conversationEvents.js';
import * as locks from '../src/services/conversationLock.js';
import { ensureSharedInbox } from '../src/services/unlinkedMessaging.js';
import { setupChatSocket, joinUserSocketsToConversation, broadcastMessageToParticipants } from '../src/websocket/chatHandler.js';

const secret = 'synthetic-race-only-'.repeat(4), prefix = `community-race-${randomUUID()}`;
const app = express().use(express.json()).use('/api', router).use('/api/chat', chatRouter);
const http = createServer(app), io = new Server(http);
const sockets: Socket[] = [], groupIds: string[] = [], conversationIds: string[] = [];
const q = async (query: string, params = {}) => { const session = state.driver.session(); try { return await session.run(query, params); } finally { await session.close(); } };
const person = (name: string) => ({ issuer: 'https://id.ideaflow.app/api/auth', subject: `${prefix}-${name}`, name });
const snapshot = () => { const groupId = randomUUID(); groupIds.push(groupId); return { groupId, revision: 1, name: 'Race fixture', organizer: person('owner'), members: [person('member')], deleted: false }; };
const post = (body: unknown) => request(app).post('/api/unlinked/groups/sync').auth(secret, { type: 'bearer' }).send(body);
const token = (id: string) => jwt.sign({ userId: id, email: 'fixture@example.test' }, secret);
const userId = async (subject: string) => (await q('MATCH(u:User {ideaflowSub:$subject}) RETURN u.id AS id', { subject })).records[0].get('id') as string;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const login = async (id: string) => {
  const address = http.address() as { port: number };
  const socket = connect(`http://127.0.0.1:${address.port}`, { auth: { token: token(id) }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const events: Array<{ type: string; data: any }> = [];
  socket.onAny((type, data) => events.push({ type, data }));
  return { socket, events, flush: () => socket.timeout(3000).emitWithAck('test:barrier') };
};
const suite = process.env.NEO4J_TEST_URI ? describe : describe.skip;
suite('community membership publication races', () => {
  beforeAll(async () => {
    state.driver = neo4j.driver(process.env.NEO4J_TEST_URI!, neo4j.auth.basic(process.env.NEO4J_TEST_USER ?? 'neo4j', process.env.NEO4J_TEST_PASSWORD!));
    vi.stubEnv('UNLINKED_MESSAGING_SECRET', secret); vi.stubEnv('JWT_SECRET', secret);
    for (const query of ['CREATE CONSTRAINT community_identity IF NOT EXISTS FOR(u:User) REQUIRE u.ideaflowIdentityKey IS UNIQUE', 'CREATE CONSTRAINT community_sync IF NOT EXISTS FOR(s:UnlinkedGroupSync) REQUIRE s.groupId IS UNIQUE', 'CREATE CONSTRAINT community_conversation IF NOT EXISTS FOR(c:Conversation) REQUIRE c.id IS UNIQUE']) await q(query);
    setupChatSocket(io); app.set('io', io);
    io.on('connection', socket => socket.on('test:barrier', ack => ack()));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>(resolve => io.close(() => resolve()));
    await q('MATCH(m:Message) WHERE m.conversationId IN $conversationIds OR EXISTS { MATCH(c:Conversation {id:m.conversationId}) WHERE c.unlinkedGroupId IN $groupIds } DETACH DELETE m', {conversationIds,groupIds});
    await q('MATCH(c:Conversation) WHERE c.unlinkedGroupId IN $groupIds OR c.id IN $conversationIds OPTIONAL MATCH(c)-[:HAS_INVITE]->(i:GroupInvite) DETACH DELETE c,i', { groupIds, conversationIds });
    await q('MATCH(s:UnlinkedGroupSync) WHERE s.groupId IN $groupIds DELETE s', { groupIds });
    await q('MATCH(u:User) WHERE u.ideaflowSub STARTS WITH $prefix DETACH DELETE u', { prefix });
    await state.driver.close(); vi.unstubAllEnvs();
  });
  it('does not publish an old revision after a newer removal or allow a stale socket join', async () => {
    const body = snapshot();
    const original = groups.syncUnlinkedGroup, entered = deferred(), release = deferred();
    const spy = vi.spyOn(groups, 'syncUnlinkedGroup').mockImplementation(async input => {
      const result = await original(input);
      if (input.groupId === body.groupId && input.revision === 1) { entered.resolve(); await release.promise; }
      return result;
    });
    const older = post(body).then(r => r);
    await entered.promise;
    const memberId = await userId(body.members[0].subject), client = await login(memberId);
    try {
      const newer = await post({ ...body, revision: 2, members: [] }); expect(newer.status, newer.text).toBe(200);
      release.resolve(); expect((await older).status).toBe(200);
      expect(await joinUserSocketsToConversation(io, memberId, newer.body.conversationId)).toBe(false);
      client.socket.emit('conversation:join', newer.body.conversationId); await client.flush();
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${newer.body.conversationId}`)).toBe(false);
      io.to(`conversation:${newer.body.conversationId}`).emit('message:updated', { content: 'synthetic private edit' });
      await client.flush();
      expect(client.events.filter(e => ['conversation:created', 'conversation:updated', 'message:updated'].includes(e.type))).toEqual([]);
    } finally { release.resolve(); spy.mockRestore(); }
  });
  it('replays inbox discovery and removal after committed sync projection failures', async () => {
    const body = snapshot(); await groups.syncUnlinkedGroup(body);
    const memberId = await userId(body.members[0].subject), client = await login(memberId);
    const original = chat.loadConversation;
    let fail = true;
    const spy = vi.spyOn(chat, 'loadConversation').mockImplementation(async (...args) => { if (fail) throw new Error('synthetic projection failure'); return original(...args); });
    try {
      expect((await post(body)).status).toBe(503);
      fail = false; const retry = await post(body); expect(retry.status, retry.text).toBe(200); await client.flush();
      expect(client.events.some(e => e.type === 'conversation:created' && e.data.conversation.id === retry.body.conversationId)).toBe(true);
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${retry.body.conversationId}`)).toBe(true);
      fail = true; const removed = { ...body, revision: 2, members: [] };
      expect((await post(removed)).status).toBe(503); await client.flush(); client.events.length = 0;
      fail = false; expect((await post(removed)).status).toBe(200); await client.flush();
      expect(client.events.some(e => e.type === 'participant:removed' && e.data.userId === memberId)).toBe(true);
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${retry.body.conversationId}`)).toBe(false);
      const inbox = await request(app).get('/api/chat/conversations').auth(token(memberId), { type: 'bearer' });
      expect(inbox.body.some((c: any) => c.id === retry.body.conversationId)).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it('serializes projection publication before a newer roster can commit', async () => {
    const body = snapshot(); const original = chat.loadConversation, entered = deferred(), release = deferred();
    const spy = vi.spyOn(chat, 'loadConversation').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    const older = post(body).then(r => r); await entered.promise;
    let newerFinished = false;
    const newer = post({ ...body, revision: 2, members: [] }).then(r => { newerFinished = true; return r; });
    try {
      await new Promise(resolve => setTimeout(resolve, 75)); expect(newerFinished).toBe(false);
      release.resolve(); expect((await older).status).toBe(200); expect((await newer).status).toBe(200);
    } finally { release.resolve(); spy.mockRestore(); }
  });
  it.each(['add', 'remove', 'invite', 'rename'])('rejects a %s paused until after migration without fanout', async action => {
    const body = snapshot(); await groups.syncUnlinkedGroup(body);
    const owner = await userId(body.organizer.subject), member = await userId(body.members[0].subject);
    const outsider = await ensureSharedInbox(person('outsider'), 'Outsider');
    const client = await login(action === 'add' ? outsider.id : member);
    const created = await request(app).post('/api/chat/conversations').auth(token(owner), { type: 'bearer' }).send({ type: 'group', participantIds: [member], title: 'Original' });
    expect(created.status, created.text).toBe(201); const id = created.body.id; conversationIds.push(id); await client.flush(); client.events.length = 0;
    const original = locks.withConversationLock, entered = deferred(), release = deferred(); let pause = true;
    const spy = vi.spyOn(locks, 'withConversationLock').mockImplementation(async (conversationId, callback) => {
      if (pause && conversationId === id) { pause = false; entered.resolve(); await release.promise; }
      return original(conversationId, callback);
    });
    const route = `/api/chat/conversations/${id}`;
    const req = action === 'add' ? request(app).post(`${route}/participants`).send({ userId: outsider.id })
      : action === 'remove' ? request(app).delete(`${route}/participants/${member}`)
      : action === 'invite' ? request(app).post(`${route}/invites`).send({}) : request(app).patch(route).send({ title: 'Wrong' });
    const pending = req.auth(token(owner), { type: 'bearer' }).then(r => r); await entered.promise;
    try {
      const migration = snapshot(); expect((await post({ ...migration, existingConversationId: id })).status).toBe(200);
      await client.flush(); client.events.length = 0; release.resolve(); expect((await pending).status).toBe(409); await client.flush();
      expect(client.events.filter(e => ['participant:added', 'participant:removed', 'conversation:updated'].includes(e.type))).toEqual([]);
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${id}`)).toBe(action !== 'add');
      expect((await q('MATCH(:User {id:$userId})-[:PARTICIPATES_IN]->(:Conversation {id:$id}) RETURN true AS member', {userId:outsider.id,id})).records).toHaveLength(0);
      expect((await q('MATCH(c:Conversation {id:$id}) OPTIONAL MATCH(c)-[:HAS_INVITE]->(i) RETURN c.title AS title,count(i) AS invites', { id })).records[0].get('title')).toBe(migration.name);
    } finally { release.resolve(); spy.mockRestore(); }
  });
  it('rejects missing migration targets, persists safe names and allows only emoji customization', async () => {
    const body = snapshot(), missing = `missing-${randomUUID()}`;
    expect((await post({ ...body, existingConversationId: missing })).status).toBe(409);
    expect((await q('MATCH(c:Conversation {id:$id}) RETURN c', { id: missing })).records).toHaveLength(0);
    const privatePerson = person('private-' + randomUUID()); privatePerson.name = 'alice@example.test';
    const result = await post({ ...body, members: [privatePerson] }); expect(result.status, result.text).toBe(200);
    const id = await userId(privatePerson.subject);
    expect((await q('MATCH(u:User {id:$id}) RETURN u.name AS name', { id })).records[0].get('name')).toBe('OpenChat member');
    const patch = (payload: unknown) => request(app).patch(`/api/chat/conversations/${result.body.conversationId}`).auth(token(id), { type: 'bearer' }).send(payload);
    const emoji = await patch({ quickEmoji: '🔥' }); expect(emoji.status, emoji.text).toBe(200); expect(emoji.body.quickEmoji).toBe('🔥');
    expect((await patch({ quickEmoji: null })).status).toBe(200);
    expect((await patch({ title: 'Wrong', quickEmoji: '🔥' })).status).toBe(409);
  });
  it.each(['add', 'remove', 'emoji'])('publishes no %s effects from a rolled-back transaction', async action => {
    const body = snapshot(); await groups.syncUnlinkedGroup(body);
    const owner = await userId(body.organizer.subject), member = await userId(body.members[0].subject);
    const client = await login(member);
    const created = await request(app).post('/api/chat/conversations').auth(token(owner), {type:'bearer'}).send({type:'group',title:'Rollback',participantIds:action === 'add' ? [] : [member]});
    expect(created.status,created.text).toBe(201); const id = created.body.id; conversationIds.push(id); await client.flush(); client.events.length = 0;
    const original = locks.withConversationLock; let rejected = false;
    const spy = vi.spyOn(locks,'withConversationLock').mockImplementation((conversationId,callback) => original(conversationId,async tx => {
      const result = await callback(tx);
      if (conversationId === id && !rejected) { rejected = true; throw new Error('synthetic commit rejection'); }
      return result;
    }));
    try {
      const route = `/api/chat/conversations/${id}`;
      const req = action === 'add' ? request(app).post(`${route}/participants`).send({userId:member})
        : action === 'remove' ? request(app).delete(`${route}/participants/${member}`) : request(app).patch(route).send({quickEmoji:'🔥'});
      expect((await req.auth(token(owner),{type:'bearer'})).status).toBe(500); expect(rejected).toBe(true); await client.flush();
      const persisted = await q('MATCH(c:Conversation {id:$id}) RETURN EXISTS { MATCH(:User {id:$member})-[:PARTICIPATES_IN]->(c) } AS member,c.quickEmoji AS emoji',{id,member});
      expect(persisted.records[0].get('member')).toBe(action !== 'add'); expect(persisted.records[0].get('emoji')).toBeNull();
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${id}`)).toBe(action !== 'add');
      expect(client.events.filter(e => ['participant:added','participant:removed','conversation:updated'].includes(e.type))).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it.each([true,false])('rejects an accepted invite revoked before projection with sockets=%s', async socketsEnabled => {
    const body = snapshot(); await groups.syncUnlinkedGroup(body);
    const owner = await userId(body.organizer.subject), outsider = await ensureSharedInbox(person('invite-outsider'),'Invite outsider');
    const created = await request(app).post('/api/chat/conversations').auth(token(owner),{type:'bearer'}).send({type:'group',title:'Invite fixture',participantIds:[]});
    expect(created.status,created.text).toBe(201); const id = created.body.id; conversationIds.push(id);
    const invite = await request(app).post(`/api/chat/conversations/${id}/invites`).auth(token(owner),{type:'bearer'}).send({}); expect(invite.status).toBe(201);
    const client = await login(outsider.id), entered = deferred(), release = deferred(), original = invites.acceptInviteTransaction;
    const spy = vi.spyOn(invites,'acceptInviteTransaction').mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; });
    if (!socketsEnabled) app.set('io',undefined);
    const pending = request(app).post(`/api/chat/invites/${invite.body.token}/accept`).auth(token(outsider.id),{type:'bearer'}).send({}).then(r => r);
    await entered.promise;
    try {
      const migration = snapshot(); expect((await post({...migration,existingConversationId:id})).status).toBe(200); await client.flush(); client.events.length = 0;
      release.resolve(); const response = await pending; expect(response.status,response.text).toBe(404); expect(response.body.conversation).toBeUndefined(); await client.flush();
      expect(client.events.filter(e => ['participant:added','conversation:created','conversation:updated'].includes(e.type))).toEqual([]);
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${id}`)).toBe(false);
    } finally { release.resolve(); spy.mockRestore(); app.set('io',io); }
  });
  it('keeps invite response and inbox publication ordered before concurrent migration', async () => {
    const body = snapshot(); await groups.syncUnlinkedGroup(body);
    const owner = await userId(body.organizer.subject), outsider = await ensureSharedInbox(person('invite-ordered'),'Invite ordered');
    const created = await request(app).post('/api/chat/conversations').auth(token(owner),{type:'bearer'}).send({type:'group',title:'Invite ordered',participantIds:[]});
    const id = created.body.id; conversationIds.push(id);
    const invite = await request(app).post(`/api/chat/conversations/${id}/invites`).auth(token(owner),{type:'bearer'}).send({});
    const client = await login(outsider.id), entered = deferred(), release = deferred(), original = locks.withConversationLock;
    let pause = true;
    const spy = vi.spyOn(locks,'withConversationLock').mockImplementation((conversationId,callback) => original(conversationId, tx => callback(new Proxy(tx,{
      get(target,key,receiver) {
        if(key !== 'run') return Reflect.get(target,key,receiver);
        return async (...args:any[]) => {
          const result = await target.run(...args);
          if(pause && conversationId === id && result.records.some(row => row.keys.includes('conversation'))) {
            pause = false; entered.resolve(); await release.promise;
          }
          return result;
        };
      }
    }))));
    const pending = request(app).post(`/api/chat/invites/${invite.body.token}/accept`).auth(token(outsider.id),{type:'bearer'}).send({}).then(r => r); await entered.promise;
    const migration = snapshot(); let finished = false;
    const migrated = post({...migration,existingConversationId:id}).then(r => { finished = true; return r; });
    try {
      await new Promise(resolve => setTimeout(resolve,75)); expect(finished).toBe(false);
      release.resolve(); const response = await pending; expect(response.status,response.text).toBe(200);
      expect(response.body.conversation.participants.some((p:any) => p.user.id === outsider.id)).toBe(true);
      expect((await migrated).status).toBe(200); await client.flush();
      const added = client.events.findIndex(e => e.type === 'participant:added' && e.data.conversationId === id);
      const removed = client.events.findIndex(e => e.type === 'participant:removed' && e.data.conversationId === id);
      expect(added).toBeGreaterThanOrEqual(0); expect(removed).toBeGreaterThan(added);
      expect(client.events.slice(removed+1).filter(e => ['conversation:created','participant:added'].includes(e.type))).toEqual([]);
    } finally { release.resolve(); spy.mockRestore(); }
  });
  it('never sends message content to a revoked socket during delayed eviction', async () => {
    const body = snapshot(), initial = await post(body); expect(initial.status,initial.text).toBe(200); const id = initial.body.conversationId;
    const owner = await userId(body.organizer.subject), member = await userId(body.members[0].subject);
    const client = await login(member), retained = await login(owner); await post(body); await client.flush(); await retained.flush(); client.events.length = 0; retained.events.length = 0;
    const messageId = randomUUID();
    await q(`MATCH(c:Conversation {id:$id}),(u:User {id:$owner}) CREATE(m:Message {id:$messageId,conversationId:$id,senderId:$owner,content:'Synthetic original',messageType:'text',createdAt:datetime()}) CREATE(m)-[:IN_CONVERSATION]->(c) CREATE(u)-[:SENT]->(m)`,{id,owner,messageId});
    const entered = deferred(), release = deferred(), original = groups.syncUnlinkedGroup;
    const spy = vi.spyOn(groups,'syncUnlinkedGroup').mockImplementation(async input => { const result = await original(input); if(input.groupId === body.groupId && input.revision === 2) { entered.resolve(); await release.promise; } return result; });
    const pending = post({...body,revision:2,members:[]}).then(r => r); await entered.promise;
    try {
      expect(io.sockets.sockets.get(client.socket.id!)!.rooms.has(`conversation:${id}`)).toBe(true);
      const edit = await request(app).patch(`/api/chat/messages/${messageId}`).auth(token(owner),{type:'bearer'}).send({content:'Synthetic secret edit'}); expect(edit.status,edit.text).toBe(200);
      expect((await request(app).post(`/api/chat/messages/${messageId}/reactions`).auth(token(owner),{type:'bearer'}).send({emoji:'👍'})).status).toBe(201);
      expect((await request(app).delete(`/api/chat/messages/${messageId}/reactions/${encodeURIComponent('👍')}`).auth(token(owner),{type:'bearer'})).status).toBe(200);
      await broadcastMessageToParticipants(io,id,{id:randomUUID(),conversationId:id,content:'Synthetic new content'});
      await publishConversationEvent(io,id,'message:transcript',{messageId,transcript:'Synthetic private transcript'});
      await publishConversationEvent(io,id,'message:preview-ready',{messageId,preview:{title:'Synthetic private preview'}});
      expect((await request(app).delete(`/api/chat/messages/${messageId}`).auth(token(owner),{type:'bearer'})).status).toBe(200);
      await client.flush(); await retained.flush();
      expect(client.events.filter(e => e.type.startsWith('message:'))).toEqual([]);
      expect(retained.events.filter(e => e.type === 'message:updated')).toHaveLength(2);
      expect(retained.events.filter(e => e.type === 'message:reactions-updated')).toHaveLength(2);
      expect(retained.events.filter(e => e.type === 'message:new')).toHaveLength(1);
      expect(retained.events.filter(e => e.type === 'message:transcript')).toHaveLength(1);
      expect(retained.events.filter(e => e.type === 'message:preview-ready')).toHaveLength(1);
    } finally { release.resolve(); await pending; spy.mockRestore(); }
  });
  it('holds the roster lock through message recipient selection and emission', async () => {
    const body = snapshot(), initial = await post(body), id = initial.body.conversationId;
    const member = await userId(body.members[0].subject), client = await login(member);
    const original = locks.withConversationLock, entered = deferred(), release = deferred(); let pause = true;
    const spy = vi.spyOn(locks,'withConversationLock').mockImplementation((conversationId,callback) => original(conversationId,async tx => {
      if(pause && conversationId === id) { pause = false; entered.resolve(); await release.promise; }
      return callback(tx);
    }));
    const message = {id:randomUUID(),conversationId:id,content:'Synthetic ordered message'};
    const sent = broadcastMessageToParticipants(io,id,message); await entered.promise;
    let revoked = false; const removed = post({...body,revision:2,members:[]}).then(r => {revoked = true; return r;});
    try {
      await new Promise(resolve => setTimeout(resolve,75)); expect(revoked).toBe(false);
      release.resolve(); await sent; expect((await removed).status).toBe(200); await client.flush();
      expect(client.events.findIndex(e => e.type === 'message:new')).toBeLessThan(client.events.findIndex(e => e.type === 'participant:removed'));
      expect(client.events.filter(e => e.type === 'message:new')).toHaveLength(1);
    } finally {release.resolve(); spy.mockRestore();}
  });
  it('delivers direct messages and reaction updates once without conversation-room joins', async () => {
    const body = snapshot(); await groups.syncUnlinkedGroup(body);
    const owner = await userId(body.organizer.subject), member = await userId(body.members[0].subject);
    const created = await request(app).post('/api/chat/conversations').auth(token(owner),{type:'bearer'}).send({type:'direct',participantIds:[member]});
    expect(created.status,created.text).toBe(201); const id = created.body.id; conversationIds.push(id);
    const client = await login(member), sender = await login(owner);
    const sent = await request(app).post(`/api/chat/conversations/${id}/messages`).auth(token(owner),{type:'bearer'}).send({content:'Synthetic direct message',type:'text'});
    expect(sent.status,sent.text).toBe(201);
    expect((await request(app).post(`/api/chat/messages/${sent.body.id}/reactions`).auth(token(member),{type:'bearer'}).send({emoji:'👍'})).status).toBe(201);
    await client.flush(); await sender.flush();
    for(const connection of [client,sender]) {
      expect(io.sockets.sockets.get(connection.socket.id!)!.rooms.has(`conversation:${id}`)).toBe(false);
      expect(connection.events.filter(e => e.type === 'message:new' && e.data.id === sent.body.id)).toHaveLength(1);
      expect(connection.events.filter(e => e.type === 'message:reactions-updated' && e.data.messageId === sent.body.id)).toHaveLength(1);
    }
  });

});
