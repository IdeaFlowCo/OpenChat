import { createHash, createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from 'vitest';
const state=vi.hoisted(()=>({linked:true,duplicate:false,member:true,run:vi.fn(),mutations:0}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({run:state.run,close:async()=>{},executeRead:async(fn:any)=>fn({run:state.run}),executeWrite:async(fn:any)=>fn({run:state.run})})})}));
import { handleIdeaflowConnector, connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import { resolveActor } from '../src/middleware/resolveActor.js';
import { verifyConnectorAssertion,issueConnectorOperation,getConnectorPrincipal } from '../src/lib/ideaflowConnector.js';
import contextRoutes from '../src/routes/context.js';
import contentRoutes from '../src/routes/conversationContent.js';
const secret='test-only-connector-secret-32-bytes-minimum';
function sign(body:string,changes:Record<string,unknown>={},key=secret,headerValues={alg:'HS256',typ:'JWT'}) {
  const now=Math.floor(Date.now()/1000);
  const header=Buffer.from(JSON.stringify(headerValues)).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:'https://id.ideaflow.app/connector',aud:'https://chat.ideaflow.app/mcp',identity_issuer:'https://id.ideaflow.app/api/auth',sub:'subject',scope:'openchat:read openchat:write',iat:now,exp:now+60,jti:randomUUID(),body_sha256:createHash('sha256').update(body).digest('hex'),...changes})).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256',key).update(`${header}.${payload}`).digest('base64url')}`;
}
const record=(v:Record<string,unknown>)=>({get:(k:string)=>v[k]});
describe('unified OpenChat connector trust boundary',()=>{
  let server:Server,base:string;
  beforeAll(async()=>{
    const app=express();
    app.post('/api/connector/mcp',express.raw({type:'application/json'}),handleIdeaflowConnector);
    app.use(express.json());app.use('/api',connectorOperationGuard);
    app.use('/api/chat',contentRoutes);
    app.use('/api/chat',contextRoutes);
    app.get('/api/chat/conversations',resolveActor,(req,res)=>res.json([{id:'room',userId:req.user!.userId}]));
    app.post('/api/chat/conversations/:id/messages',resolveActor,(req,res)=>{state.mutations++;res.json({conversationId:req.params.id,...req.body,userId:req.user!.userId});});
    app.get('/api/probe',resolveActor,(req,res)=>res.json({userId:req.user?.userId,trusted:!!getConnectorPrincipal(req)}));
    await new Promise<void>(r=>{server=app.listen(0,'127.0.0.1',r);});base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async()=>{delete process.env.IDEAFLOW_CONNECTOR_SECRET;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  beforeEach(()=>{
    process.env.IDEAFLOW_CONNECTOR_SECRET=secret;process.env.OPENCHAT_CONTEXT_LANE='true';state.linked=true;state.duplicate=false;state.member=true;state.mutations=0;
    state.run.mockReset().mockImplementation(async(q:string,p:any)=>{
      if(q.includes('ideaflowIssuer:$issuer'))return{records:state.linked?[record({id:'owner'}),...(state.duplicate?[record({id:'other'})]:[])]:[]};
      if(q.includes('RETURN c.id AS conversationId'))return{records:state.member?[record({conversationId:'room'})]:[]};
      if(q.includes('CREATE (t:Thought')){state.mutations++;return{records:[record({t:{properties:{...p,authorId:p.userId,revision:1,createdAt:p.now,updatedAt:p.now,connectorAgentId:p.connectorAgentId,agentName:p.connectorAgentName}},authorName:'Owner'})]};}
      return{records:[]};
    });
  });
  async function call(method:string,params?:unknown,claims:Record<string,unknown>={}) {
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})});
    return fetch(`${base}/api/connector/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${sign(body,claims)}`},body});
  }
  it('accepts exact signature and bytes once; rejects scope/audience/lifetime/issuer tampering',()=>{
    const body='{"jsonrpc":"2.0","method":"tools/list"}',token=sign(body);
    expect(verifyConnectorAssertion(token,Buffer.from(body),secret)?.sub).toBe('subject');
    expect(verifyConnectorAssertion(token,Buffer.from(body),secret)).toBeNull();
    for(const claim of [{aud:'other'},{iss:'other'},{identity_issuer:'other'},{sub:''},{jti:''},{exp:0},{iat:Math.floor(Date.now()/1000)+10},{exp:Math.floor(Date.now()/1000)+61},{scope:'openchat:read vision:write'}]) {
      expect(verifyConnectorAssertion(sign(body,claim),Buffer.from(body),secret)).toBeNull();
    }
    expect(verifyConnectorAssertion(sign(body,{},'wrong'),Buffer.from(body),secret)).toBeNull();
    expect(verifyConnectorAssertion(sign(body),Buffer.from(body+' '),secret)).toBeNull();
    expect(verifyConnectorAssertion(sign(body),Buffer.from(body),'')).toBeNull();
  });
  it('lists only granted tools and checks scope on direct calls',async()=>{
    const listing=await (await call('tools/list',undefined,{scope:'openchat:read'})).json() as any;
    expect(listing.result.tools.map((t:any)=>t.name)).toContain('oc_list_context_posts');
    expect(listing.result.tools.every((t:any)=>t.securitySchemes[0].type==='oauth2' && t.securitySchemes[0].scopes[0]==='openchat:read')).toBe(true);
    expect(listing.result.tools.map((t:any)=>t.name)).not.toContain('oc_send_message');
    const denied=await call('tools/call',{name:'oc_send_message',arguments:{conversationId:'room',content:'test',clientRequestId:'test'}},{scope:'openchat:read'});
    expect(denied.status).toBe(403);expect(state.mutations).toBe(0);
    expect((await call('tools/call',{name:'oc_list_conversations',arguments:{}},{scope:'openchat:write'})).status).toBe(403);
  });
  it('dispatches unified reads without private access and rejects attempts to request it',async()=>{
    const read=await (await call('tools/call',{name:'oc_list_conversation_content',arguments:{conversationId:'room',filter:'all'}},{scope:'openchat:read'})).json() as any;
    expect(JSON.parse(read.result.content[0].text)).toEqual({items:[],contextAvailable:true});
    expect(state.run.mock.calls.some(([,p])=>p?.includePrivate===false)).toBe(true);
    expect((await call('tools/call',{name:'oc_list_conversation_content',arguments:{conversationId:'room',includePrivate:true}},{scope:'openchat:read'})).status).toBe(400);
    expect((await call('tools/call',{name:'oc_list_conversation_content',arguments:{conversationId:'room'}},{scope:'openchat:write'})).status).toBe(403);
  });
  it('looks up only the exact linked issuer/subject and refuses missing/ambiguous accounts',async()=>{
    state.linked=false;expect((await call('tools/list')).status).toBe(409);
    state.linked=true;state.duplicate=true;expect((await call('tools/list')).status).toBe(409);
    expect(state.run.mock.calls.every(([q,p])=>q.includes('ideaflowIssuer:$issuer') && p.issuer==='https://id.ideaflow.app/api/auth' && p.subject==='subject')).toBe(true);
  });
  it('dispatches reads and writes as the linked account with server-derived Context attribution',async()=>{
    const read=await (await call('tools/call',{name:'oc_list_conversations',arguments:{}})).json() as any;
    expect(JSON.parse(read.result.content[0].text)).toEqual([{id:'room',userId:'owner'}]);
    const write=await (await call('tools/call',{name:'oc_create_context_post',arguments:{conversationId:'room',text:'Shared',clientRequestId:'test'}})).json() as any;
    expect(JSON.parse(write.result.content[0].text)).toMatchObject({authorId:'owner',agent:{id:'ideaflow-connector',name:'Ideaflow connector'}});
    state.member=false;
    const denied=await (await call('tools/call',{name:'oc_list_context_posts',arguments:{conversationId:'private'}})).json() as any;
    expect(denied.result.isError).toBe(true);
  });
  it('rejects unknown/extra arguments rather than exposing arbitrary routes or message types',async()=>{
    for(const args of [{conversationId:'room',content:'test',clientRequestId:'id',messageType:'card'}, {conversationId:'room',content:'test'}, {conversationId:[],content:'test',clientRequestId:'id'}]) {
      expect((await call('tools/call',{name:'oc_send_message',arguments:args})).status).toBe(400);
    }
    expect((await call('tools/call',{name:'arbitrary_fetch',arguments:{path:'/api/auth/me'}})).status).toBe(400);
    expect(state.mutations).toBe(0);
  });
  it('internal operation tokens are one-use, exact route/method/body bound, not JWTs',async()=>{
    const op={method:'GET',path:'/api/probe'};
    let token=issueConnectorOperation('owner',op,['openchat:read']);
    const response=await fetch(base+op.path,{headers:{Authorization:`Bearer ${token}`}});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({userId:'owner',trusted:true});
    expect((await fetch(base+op.path,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(401);
    token=issueConnectorOperation('owner',op,['openchat:read']);
    expect((await fetch(base+'/api/chat/conversations',{headers:{Authorization:`Bearer ${token}`}})).status).toBe(401);
    token=issueConnectorOperation('owner',{method:'POST',path:'/api/chat/conversations/room/messages',body:{content:'Approved'}},['openchat:write']);
    expect((await fetch(base+'/api/chat/conversations/room/messages',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({content:'Changed'})})).status).toBe(401);
    expect(state.mutations).toBe(0);
    const external=sign('{}');expect((await fetch(base+op.path,{headers:{Authorization:`Bearer ${external}`}})).status).toBe(401);
  });
});
