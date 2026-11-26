import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), emit: vi.fn(), room: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close, executeWrite: async (work: (tx: {run:typeof mocks.run})=>unknown) => work({run:mocks.run}) }) }) }));
vi.mock('../src/services/contextAccess.js', () => ({ acquireContextAclLocks: vi.fn() }));
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
  expect(response.status).toBe(200);expect(response.body).toEqual({messageId:'m',thoughtId:null,status:'none'});
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
  expect(query).toContain('PARTICIPATES_IN');expect(query).toContain('m.deletedAt IS NULL');expect(query).toContain('MERGE (t:Thought');expect(query).not.toContain('PINNED_IN');expect(params).toMatchObject({userId:'synthetic-owner',thoughtId,status:'open'});
});
it('returns no content if membership disappears before the locked write', async () => {
  mocks.run.mockResolvedValueOnce({records:[record({conversationId:'chat',thoughtId:'existing'})]}).mockResolvedValueOnce({records:[]});
  const response=await request(app).put('/api/chat/message-status?messageId=m').set('Authorization',auth).send({status:'closed'});
  expect(response.status).toBe(404);expect(mocks.emit).not.toHaveBeenCalled();
});
it('reads only the caller’s source-bound capture and does not leak failures', async () => {
  mocks.run.mockResolvedValueOnce({records:[record({thoughtId:'existing',status:'closed'})]});
  const response=await request(app).get('/api/chat/message-status?messageId=m').set('Authorization',auth);
  expect(response.body).toEqual({messageId:'m',thoughtId:'existing',status:'closed'});expect(response.headers['cache-control']).toBe('no-store');
  expect(mocks.run.mock.calls[0]![0]).toContain('userId:$userId');
  mocks.run.mockRejectedValueOnce(new Error('synthetic private detail'));
  const failed=await request(app).get('/api/chat/message-status?messageId=m').set('Authorization',auth);
  expect(failed.status).toBe(500);expect(JSON.stringify(failed.body)).not.toContain('private detail');
});
