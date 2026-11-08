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
import { peopleSuggestions } from '../src/services/peopleSuggestions.js';
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
    app.get('/api/chat/people-suggestions',resolveActor,peopleSuggestions);
    app.post('/api/chat/people-suggestions',resolveActor,peopleSuggestions);
    app.get('/api/chat/conversations',resolveActor,(req,res)=>res.json([{id:'room',userId:req.user!.userId}]));
    app.post('/api/chat/conversations/:id/messages',resolveActor,(req,res)=>{state.mutations++;res.json({conversationId:req.params.id,...req.body,userId:req.user!.userId});});
    app.get('/api/private/things',resolveActor,(req,res)=>res.json({things:[],nextCursor:null,total:0,query:req.query,owner:req.user!.userId}));
    app.post('/api/private/contact-source-batches',resolveActor,(req,res)=>res.json({cards:req.body.cards,owner:req.user!.userId}));
    app.put('/api/private/things/:thingId/people-state',resolveActor,(req,res)=>res.json({thingId:req.params.thingId,...req.body,owner:req.user!.userId}));
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
    const clock=vi.spyOn(Date,'now').mockReturnValue(1_793_926_800_000);
    try {
    const body='{"jsonrpc":"2.0","method":"tools/list"}',token=sign(body);
    expect(verifyConnectorAssertion(token,Buffer.from(body),secret)?.sub).toBe('subject');
    expect(verifyConnectorAssertion(token,Buffer.from(body),secret)).toBeNull();
    for(const claim of [{aud:'other'},{iss:'other'},{identity_issuer:'other'},{sub:''},{jti:''},{exp:0},{iat:Math.floor(Date.now()/1000)+10},{exp:Math.floor(Date.now()/1000)+61},{scope:'openchat:read vision:write'}]) {
      expect(verifyConnectorAssertion(sign(body,claim),Buffer.from(body),secret)).toBeNull();
    }
    expect(verifyConnectorAssertion(sign(body,{},'wrong'),Buffer.from(body),secret)).toBeNull();
    expect(verifyConnectorAssertion(sign(body),Buffer.from(body+' '),secret)).toBeNull();
    expect(verifyConnectorAssertion(sign(body),Buffer.from(body),'')).toBeNull();
    } finally { clock.mockRestore(); }
  });
  it('pages private people and accepts bounded structured source cards without owner spoofing',async()=>{
    const read=await call('tools/call',{name:'oc_list_private_things',arguments:{kind:'person',limit:73,details:true,after:'synthetic-cursor'}},{scope:'openchat:read'});
    expect(read.status).toBe(200);
    const page=await read.json() as any;
    const content=JSON.parse(page.result.content[0].text);
    expect(content).toMatchObject({owner:'owner',query:{kind:'person',limit:'73',details:'true',after:'synthetic-cursor'},total:0,nextCursor:null});
    const card={source:'synthetic:book',sourceId:'one',name:'Synthetic',data:{schemaVersion:1,details:[{kind:'phone',value:'+15555550100'}]}};
    const written=await call('tools/call',{name:'oc_import_contact_sources',arguments:{cards:[card]}},{scope:'openchat:write'});
    expect(written.status).toBe(200);
    const body=await written.json() as any;
    expect(JSON.parse(body.result.content[0].text)).toEqual({cards:[card],owner:'owner'});
    expect((await call('tools/call',{name:'oc_import_contact_sources',arguments:{cards:[{...card,ownerKey:'other'}]}},{scope:'openchat:write'})).status).toBe(400);
    expect((await call('tools/call',{name:'oc_import_contact_sources',arguments:{cards:Array(26).fill(card)}},{scope:'openchat:write'})).status).toBe(400);
    expect((await call('tools/call',{name:'oc_import_contact_sources',arguments:{cards:[card]}},{scope:'openchat:read'})).status).toBe(403);
  });
  it('requires a durable People operation ID and forwards opaque fields without allowing actor spoofing',async()=>{
    const payload={schemaVersion:1,card:{important:true},future:{fromMe:true,text:'Synthetic opaque',recordedBy:'kept',author:'original',source:'original'}};
    const args={thingId:'synthetic-person',operationId:'synthetic-op-1',expectedRevision:2,payload};
    const response=await call('tools/call',{name:'oc_save_people_state',arguments:args},{scope:'openchat:write'});
    expect(response.status).toBe(200);
    const result=await response.json() as any;
    expect(JSON.parse(result.result.content[0].text)).toEqual({...args,owner:'owner'});
    const {operationId,...withoutID}=args;
    expect((await call('tools/call',{name:'oc_save_people_state',arguments:withoutID},{scope:'openchat:write'})).status).toBe(400);
    expect((await call('tools/call',{name:'oc_save_people_state',arguments:{...args,provenance:{author:'owner'}}},{scope:'openchat:write'})).status).toBe(400);
    expect((await call('tools/call',{name:'oc_save_people_state',arguments:args},{scope:'openchat:read'})).status).toBe(403);
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
  it('passes validated Vision provenance through oc_send_message and lists oc_resolve_handle under write',async()=>{
    const provenance={service:'vision',noteId:'note-1',loopId:'loop-1',ownerSubject:'subject'};
    const sent=await (await call('tools/call',{name:'oc_send_message',arguments:{conversationId:'room',content:'From my note',clientRequestId:'r1',provenance}})).json() as any;
    expect(JSON.parse(sent.result.content[0].text)).toMatchObject({conversationId:'room',content:'From my note',clientRequestId:'r1',provenance,userId:'owner'});
    for(const bad of [{...provenance,service:'email'},{...provenance,extra:true},'vision']) {
      expect((await call('tools/call',{name:'oc_send_message',arguments:{conversationId:'room',content:'x',clientRequestId:'r2',provenance:bad}})).status).toBe(400);
    }
    const listing=await (await call('tools/list')).json() as any;
    const resolve=listing.result.tools.find((t:any)=>t.name==='oc_resolve_handle');
    expect(resolve.inputSchema.properties.handle.enum).toEqual(['agent']);
    expect(resolve.annotations.readOnlyHint).toBe(false);
    const readOnly=await (await call('tools/list',undefined,{scope:'openchat:read'})).json() as any;
    expect(readOnly.result.tools.map((t:any)=>t.name)).not.toContain('oc_resolve_handle');
  });
  it('rejects unknown/extra arguments rather than exposing arbitrary routes or message types',async()=>{
    for(const args of [{conversationId:'room',content:'test',clientRequestId:'id',messageType:'card'}, {conversationId:'room',content:'test'}, {conversationId:[],content:'test',clientRequestId:'id'}]) {
      expect((await call('tools/call',{name:'oc_send_message',arguments:args})).status).toBe(400);
    }
    expect((await call('tools/call',{name:'arbitrary_fetch',arguments:{path:'/api/auth/me'}})).status).toBe(400);
    expect(state.mutations).toBe(0);
  });
  it('exposes metadata only through granted read tools and derives the viewer from its principal',async()=>{
    const listing=await (await call('tools/list',undefined,{scope:'openchat:read'})).json() as any;
    expect(listing.result.tools.find((t:any)=>t.name==='oc_suggest_people').annotations.readOnlyHint).toBe(true);
    const response=await (await call('tools/call',{name:'oc_suggest_people',arguments:{q:'Ada'}},{scope:'openchat:read'})).json() as any;
    expect(JSON.parse(response.result.content[0].text)).toEqual({people:[]});
    expect(state.run.mock.calls.some(([q,p])=>q.includes('lastChattedAt')&&p.userId==='owner'&&p.name==='ada')).toBe(true);
    expect((await call('tools/call',{name:'oc_suggest_people',arguments:{userId:'other'}},{scope:'openchat:read'})).status).toBe(400);
    expect((await call('tools/call',{name:'oc_suggest_people',arguments:{}},{scope:'openchat:write'})).status).toBe(403);
    const token=issueConnectorOperation('owner',{method:'GET',path:'/api/chat/people-suggestions'},['openchat:write']);
    expect((await fetch(base+'/api/chat/people-suggestions',{headers:{Authorization:`Bearer ${token}`}})).status).toBe(404);
    const get=issueConnectorOperation('owner',{method:'GET',path:'/api/chat/people-suggestions?subjects=a&subjects=b'},['openchat:read']);
    expect((await fetch(base+'/api/chat/people-suggestions?subjects=a&subjects=b',{headers:{Authorization:`Bearer ${get}`}})).status).toBe(400);
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
