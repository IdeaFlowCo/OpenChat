import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks=vi.hoisted(()=>({read:vi.fn(),ingest:vi.fn(),device:vi.fn(),add:vi.fn(),close:vi.fn()}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({close:mocks.close})})}));
vi.mock('../src/services/messageCaptures.js',async original=>({...(await original<object>()),listCaptures:mocks.read,ingestCaptures:mocks.ingest,authenticateCaptureDevice:mocks.device,addCapture:mocks.add}));
import router from '../src/routes/messageCaptures.js';
const app=express();app.use(express.json());app.use('/api/captures',router);
const token=(embedded?:string)=>jwt.sign({userId:'owner',email:'owner@example.test',...(embedded?{embedded}:{})},process.env.JWT_SECRET||'dev-secret-change-me');
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockResolvedValue({items:[]});mocks.device.mockResolvedValue('device-owner');mocks.ingest.mockResolvedValue({accepted:1});mocks.add.mockResolvedValue({id:'new'});});
it('requires a direct human session for reads and manual writes',async()=>{
  expect((await request(app).get('/api/captures')).status).toBe(401);
  expect((await request(app).get('/api/captures').auth('occ_'+'a'.repeat(43),{type:'bearer'})).status).toBe(401);
  expect((await request(app).get('/api/captures').auth(token('unlinked'),{type:'bearer'})).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  const r=await request(app).get('/api/captures').auth(token(),{type:'bearer'});
  expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(mocks.read.mock.calls[0][1]).toBe('owner');
});
it('derives ingest ownership from a dedicated credential, never from request JSON',async()=>{
  const r=await request(app).post('/api/captures/ingest').auth('occ_'+'a'.repeat(43),{type:'bearer'}).send({ownerId:'victim',captures:[{}]});
  expect(r.status).toBe(200);expect(mocks.ingest.mock.calls[0][1]).toBe('device-owner');
});
it('validates query shapes before the data service runs',async()=>{
  const r=await request(app).get('/api/captures?limit=3.5').auth(token(),{type:'bearer'});
  expect(r.status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
});
it('adds direct entries as the signed-in owner',async()=>{
  const r=await request(app).post('/api/captures').auth(token(),{type:'bearer'}).send({text:'A direct note',ownerId:'someone-else'});
  expect(r.status).toBe(201);expect(mocks.add.mock.calls[0][1]).toBe('owner');
});
