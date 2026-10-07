import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({preference:vi.fn(),publish:vi.fn(),close:vi.fn()}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({close:state.close})})}));
vi.mock('../src/services/contextHosted.js',()=>({
  hostedPreference:state.preference,publishHostedRequest:state.publish,
  listHostedRequests:vi.fn(),getHostedRequest:vi.fn(),reviseHostedRequest:vi.fn(),stopHostedRequest:vi.fn(),
}));
import routes from '../src/routes/contextHosted.js';
import { connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import { getConnectorPrincipal,issueConnectorOperation } from '../src/lib/ideaflowConnector.js';
const base='/api/chat/context-hosted';
const app=express();let trustedSeen=false;
app.use(express.json());app.use('/api',connectorOperationGuard);
app.use((req,_res,next)=>{trustedSeen=!!getConnectorPrincipal(req);next();});
app.use(base,routes);
const token=(extra:Record<string,unknown>={})=>jwt.sign({userId:'human-owner',email:'synthetic@example.invalid',...extra},process.env.JWT_SECRET!,{expiresIn:60});
describe('hosted Context human approval boundary',()=>{
  beforeEach(()=>{process.env.JWT_SECRET='synthetic-hosted-route-test-secret';vi.clearAllMocks();trustedSeen=false;state.preference.mockResolvedValue({enabled:false,available:true});state.publish.mockResolvedValue({status:'published'});});
  it('accepts a human session and sets no-store on private responses',async()=>{
    const response=await request(app).get(base+'/preferences').set('Authorization',`Bearer ${token()}`);
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    expect(state.preference).toHaveBeenCalledWith(expect.anything(),'human-owner');
  });
  it('rejects an agent key for preference reads, opt-in, and publication',async()=>{
    for(const [method,path,body] of [['get','/preferences',undefined],['put','/preferences',{enabled:true}],['post','/requests/job/publish',{draftId:'draft',text:'reply',approvalDigest:'digest'}]] as const){
      const response=await request(app)[method](base+path).set('Authorization','Bearer oc_synthetic-agent-key').send(body);
      expect(response.status).toBe(401);
    }
    expect(state.preference).not.toHaveBeenCalled();expect(state.publish).not.toHaveBeenCalled();
  });
  it('rejects a valid consumed exact-operation connector token even with no agentKeyId',async()=>{
    const body={draftId:'draft',text:'reply',approvalDigest:'digest'},path=base+'/requests/job/publish';
    const operation=issueConnectorOperation('human-owner',{method:'POST',path,body},['openchat:write']);
    const response=await request(app).post(path).set('Authorization',`Bearer ${operation}`).send(body);
    expect(trustedSeen).toBe(true);expect(response.status).toBe(401);expect(state.publish).not.toHaveBeenCalled();
    const pref=issueConnectorOperation('human-owner',{method:'PUT',path:base+'/preferences',body:{enabled:true}},['openchat:write']);
    expect((await request(app).put(base+'/preferences').set('Authorization',`Bearer ${pref}`).send({enabled:true})).status).toBe(401);
    expect(state.preference).not.toHaveBeenCalled();
  });
  it('rejects embedded signed sessions and ignores forged actor fields',async()=>{
    expect((await request(app).get(base+'/preferences').set('Authorization',`Bearer ${token({embedded:'ideaflow'})}`)).status).toBe(403);
    const body={draftId:'draft',text:'exact reply',approvalDigest:'digest',userId:'victim',ownerUserId:'victim',user:{userId:'victim'},agentKeyId:'fake'};
    expect((await request(app).post(base+'/requests/job/publish').set('Authorization',`Bearer ${token()}`).send(body)).status).toBe(200);
    expect(state.publish).toHaveBeenCalledWith(expect.anything(),'human-owner','job',{draftId:'draft',text:'exact reply',approvalDigest:'digest'});
  });
});
