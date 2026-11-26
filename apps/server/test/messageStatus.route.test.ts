import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), emit: vi.fn(), room: vi.fn(), publish: vi.fn(async () => undefined) }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close, executeWrite: async (work: (tx: {run:typeof mocks.run})=>unknown) => work({run:mocks.run}) }) }) }));
vi.mock('../src/services/contextAccess.js', () => ({ acquireContextAclLocks: vi.fn() }));
vi.mock('../src/services/conversationEvents.js', () => ({ publishConversationEvent: mocks.publish }));
import router, { messageStatusThoughtId } from '../src/routes/messageStatus.js';
const app = express().use(express.json()).use('/api/chat/message-status', router);
const auth = `Bearer ${jwt.sign({ userId:'synthetic-owner',email:'owner@example.test' },'dev-secret-change-me')}`;
const record = (values: Record<string,unknown>) => ({get:(key:string)=>values[key]});
beforeEach(() => { vi.clearAllMocks(); mocks.run.mockReset(); mocks.room.mockReturnValue({emit:mocks.emit}); app.set('io',{to:mocks.room}); });
it('requires authentication, validates status and never writes for missing membership', async () => {
  expect((await request(app).put('/api/chat/message-status?messageId=m').send({status:'open'})).status).toBe(401);
  expect((await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'unknown'})).status).toBe(400);
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.run.mockResolvedValue({records:[]});
  expect((await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'open'})).status).toBe(404);
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
it('clears an absent status without creating a Stream capture', async () => {
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId:null})]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'none'});
  expect(response.status).toBe(200);expect(response.body).toEqual({messageId:'m',thoughtId:null,status:'none',visibility:'private'});
  expect(mocks.run).toHaveBeenCalledTimes(1);expect(mocks.emit).not.toHaveBeenCalled();
});
it('uses deterministic per-owner capture identity and only emits to the owner', async () => {
  const thoughtId=messageStatusThoughtId('synthetic-owner','m');
  expect(thoughtId).not.toBe(messageStatusThoughtId('another-owner','m'));
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId:null})]}).mockResolvedValueOnce({records:[record({thought:{id:thoughtId,text:'Synthetic',status:'open',createdAt:'2026-01-01',updatedAt:'2026-01-01'}})]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'open'});
  expect(response.status).toBe(200);expect(response.body.thoughtId).toBe(thoughtId);
  expect(mocks.room).toHaveBeenCalledExactlyOnceWith('user:synthetic-owner');
  expect(mocks.emit).toHaveBeenCalledWith('thought:created',expect.objectContaining({thought:expect.objectContaining({status:'open'})}));
  const [query,params]=mocks.run.mock.calls[1]!;
  expect(query).toContain('PARTICIPATES_IN');expect(query).toContain('m.deletedAt IS NULL');expect(query).toContain('MERGE (t:Thought');expect(params).toMatchObject({userId:'synthetic-owner',thoughtId,status:'open',visibility:'private'});
  // A private status tells nobody else anything.
  expect(mocks.publish).not.toHaveBeenCalled();
});
it('returns no content if membership disappears before the locked write', async () => {
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId:'existing'})]}).mockResolvedValueOnce({records:[]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'closed'});
  expect(response.status).toBe(404);expect(mocks.emit).not.toHaveBeenCalled();
});
it('reads only the caller’s source-bound capture and does not leak failures', async () => {
  mocks.run.mockResolvedValueOnce({records:[record({thoughtId:'existing',status:'closed'})]});
  const response=await request(app).get('/api/chat/message-status?messageId=m').set('Authorization',auth);
  expect(response.body).toEqual({messageId:'m',thoughtId:'existing',status:'closed',visibility:'private'});expect(response.headers['cache-control']).toBe('no-store');
  expect(mocks.run.mock.calls[0]![0]).toContain('userId:$userId');
  mocks.run.mockRejectedValueOnce(new Error('synthetic private detail'));
  const failed=await request(app).get('/api/chat/message-status?messageId=m').set('Authorization',auth);
  expect(failed.status).toBe(500);expect(JSON.stringify(failed.body)).not.toContain('private detail');
});
it('rejects an unknown audience before touching the database', async () => {
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'open',visibility:'everyone'});
  expect(response.status).toBe(400);expect(mocks.run).not.toHaveBeenCalled();
});
it('shares a status with the chat through the Stream pin and tells participants only the shared value', async () => {
  const thoughtId=messageStatusThoughtId('synthetic-owner','m');
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId:null,shared:false})]}).mockResolvedValueOnce({records:[record({thought:{id:thoughtId,text:'Synthetic',status:'open',createdAt:'2026-01-01',updatedAt:'2026-01-01'},userName:'Synthetic Owner'})]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'open',visibility:'chat'});
  expect(response.status).toBe(200);expect(response.body).toMatchObject({status:'open',visibility:'chat'});
  const [query,params]=mocks.run.mock.calls[1]!;expect(query).toContain('MERGE (t)-[p:PINNED_IN]->(c)');expect(params).toMatchObject({visibility:'chat'});
  expect(mocks.publish).toHaveBeenCalledWith(expect.anything(),'chat','message-status:changed',{conversationId:'chat',messageId:'m',userId:'synthetic-owner',userName:'Synthetic Owner',status:'open',visibility:'chat'});
  expect(mocks.publish).toHaveBeenCalledWith(expect.anything(),'chat','thought:pinned',expect.objectContaining({conversationId:'chat'}));
});
it('withdrawing a shared status tells the chat only that it is gone', async () => {
  const thoughtId=messageStatusThoughtId('synthetic-owner','m');
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId,shared:true})]}).mockResolvedValueOnce({records:[record({thought:{id:thoughtId,text:'Synthetic',status:'closed',createdAt:'2026-01-01',updatedAt:'2026-01-01'},userName:'Synthetic Owner',sharedBefore:true})]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'closed',visibility:'private'});
  expect(response.body).toMatchObject({status:'closed',visibility:'private'});
  const event=mocks.publish.mock.calls.find(call=>call[2]==='message-status:changed')!;
  expect(event[3]).toMatchObject({status:'none',visibility:'private'});expect(JSON.stringify(event[3])).not.toContain('closed');
  expect(mocks.publish).toHaveBeenCalledWith(expect.anything(),'chat','thought:unpinned',{conversationId:'chat',thoughtId});
});
it('keeps a shared status shared when a client omits the audience', async () => {
  const thoughtId=messageStatusThoughtId('synthetic-owner','m');
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId,shared:true})]}).mockResolvedValueOnce({records:[record({thought:{id:thoughtId,text:'Synthetic',status:'closed',createdAt:'2026-01-01',updatedAt:'2026-01-01'},userName:'Synthetic Owner'})]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'closed'});
  expect(response.body.visibility).toBe('chat');expect(mocks.run.mock.calls[1]![1]).toMatchObject({visibility:'chat'});
});
it('lists chat statuses only for participants and filters other people’s private statuses in the query', async () => {
  mocks.run.mockResolvedValueOnce({records:[]});
  expect((await request(app).get('/api/chat/message-status/conversation?conversationId=chat').set('Authorization',auth)).status).toBe(404);
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',statuses:[{messageId:'m',status:'open',userId:'peer',userName:'Peer',visibility:'chat',own:false},null]})]});
  const response=await request(app).get('/api/chat/message-status/conversation?conversationId=chat').set('Authorization',auth);
  expect(response.status).toBe(200);expect(response.body.statuses).toEqual([{messageId:'m',status:'open',userId:'peer',userName:'Peer',visibility:'chat',own:false}]);
  const query=mocks.run.mock.calls[1]![0] as string;
  expect(query).toContain("t.captureMethod = 'message-status'");
  expect(query).toContain('(t.userId = $userId OR (EXISTS { MATCH (t)-[:PINNED_IN]->(c) } AND EXISTS { MATCH (:User {id:t.userId})-[:PARTICIPATES_IN]->(c) }))');
  expect(query).toContain('PARTICIPATES_IN');
});
