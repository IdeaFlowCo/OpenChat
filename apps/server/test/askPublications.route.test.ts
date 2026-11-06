import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock('../src/services/askPublications.js', () => ({ listAskPublications: mocks.list, readAskPublication: mocks.read }));
import router from '../src/routes/askPublications.js';
import { PrivateGraphError } from '../src/services/privateGraph.js';
const app = express().use('/api',router).post('/api/unrelated',(_req,res)=>res.json({unrelated:true}));
const auth = () => `Bearer ${jwt.sign({userId:'verified-viewer',email:'viewer@example.test'},process.env.JWT_SECRET || 'dev-secret-change-me')}`;
beforeEach(()=>{vi.clearAllMocks(); mocks.list.mockResolvedValue({publications:[],nextCursor:null}); mocks.read.mockResolvedValue({publication:{id:'safe-publication'}});});
describe('publication viewer HTTP authorization boundary',()=>{
  it('public reads are anonymous, present invalid credentials fail instead of downgrading',async()=>{
    const anonymous=await request(app).get('/api/people/publisher/ask-publications');
    expect(anonymous.status).toBe(200); expect(anonymous.headers['cache-control']).toBe('private, no-store');
    expect(mocks.list).toHaveBeenLastCalledWith(null,expect.objectContaining({publisherId:'publisher'}));
    expect((await request(app).get('/api/ask-publications/pub').set('Authorization','Bearer invalid')).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    expect((await request(app).get('/api/ask-publications/pub').set('Authorization',auth())).status).toBe(200);
    expect(mocks.read).toHaveBeenLastCalledWith('verified-viewer','pub');
  });
  it('registers shared-with-me before the ID route and binds it to verified viewer',async()=>{
    await request(app).get('/api/ask-publications/shared-with-me?cursor=opaque&limit=2').set('Authorization',auth());
    expect(mocks.list).toHaveBeenLastCalledWith('verified-viewer',{sharedOnly:true,cursor:'opaque',limit:'2'});
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('uses indistinguishable not-found errors and reports unavailable separately from empty',async()=>{
    mocks.read.mockRejectedValue(new PrivateGraphError(404,'Ask unavailable'));
    const hidden=await request(app).get('/api/ask-publications/hidden'); expect(hidden.status).toBe(404); expect(hidden.body).toEqual({error:'Ask unavailable'});
    mocks.list.mockRejectedValue(new Error('database unavailable'));
    const failed=await request(app).get('/api/people/publisher/ask-publications'); expect(failed.status).toBe(503); expect(failed.body).not.toHaveProperty('publications');
  });
  it('does not intercept unrelated API routes or their authorization',async()=>{
    const result=await request(app).post('/api/unrelated').set('Authorization','Bearer deliberately-not-a-viewer-token');
    expect(result.status).toBe(200); expect(result.body).toEqual({unrelated:true});
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
});
