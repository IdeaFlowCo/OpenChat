import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const {NEO4J_TEST_URI:uri,NEO4J_TEST_USER:user,NEO4J_TEST_PASSWORD:password}=process.env;
const integration=uri&&user&&password?describe.sequential:describe.skip;
integration('communities preserve explicit chat membership and announcement authority',{timeout:20000},()=>{
  const fixture=`community-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id=(name:string)=>`${fixture}-${name}`;
  const app=express().use(express.json()), http=createServer(app), io=new Server(http);
  let driver:Driver, db:typeof import('../src/db.js');
  let communityId:string,announcementsId:string,groupId:string,token:string,socketUrl:string;
  const createdIds:string[]=[];
  const tokenFor=(name='owner',extra:Record<string,unknown>={})=>jwt.sign({userId:id(name),email:`${name}@example.test`,...extra},process.env.JWT_SECRET||'dev-secret-change-me');
  const auth=(name='owner')=>`Bearer ${tokenFor(name)}`;
  const api=(suffix='')=>`/api/communities/${communityId}${suffix}`;
  const run=async(query:string,params:Record<string,unknown>={})=>{const s=driver.session();try{return await s.run(query,{fixture,...params});}finally{await s.close();}};
  const post=(url:string,body:unknown,name='owner')=>request(app).post(url).set('Authorization',auth(name)).send(body);
  const get=(url:string,name='owner')=>request(app).get(url).set('Authorization',auth(name));
  const join=async(name:string)=>post('/api/communities/join',{token},name);
  beforeAll(async()=>{
    process.env.NEO4J_URI=uri!;process.env.NEO4J_USER=user!;process.env.NEO4J_PASSWORD=password!;
    db=await import('../src/db.js');driver=neo4j.driver(uri!,neo4j.auth.basic(user!,password!));
    app.use('/api/communities',(await import('../src/routes/communities.js')).default);
    app.use('/api/chat',(await import('../src/routes/chat.js')).default);app.set('io',io);
    (await import('../src/websocket/chatHandler.js')).setupChatSocket(io);
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    socketUrl=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
    await run(`UNWIND $names AS name CREATE (:User {id:$fixture+'-'+name,name:'Synthetic '+name,email:name+'@example.test',fixture:$fixture})`,{names:['owner','admin','member','outsider','blocked']});
  },40000);
  afterAll(async()=>{
    if(driver){
      await run(`MATCH (co:OpenChatCommunity) WHERE co.id IN $ids OPTIONAL MATCH (co)-[:HAS_OPENCHAT_INVITE]->(i) DETACH DELETE i`,{ids:createdIds});
      await run(`MATCH (m:Message) WHERE m.conversationId IN $ids DETACH DELETE m`,{ids:createdIds});
      await run(`MATCH (n) WHERE n.fixture=$fixture OR n.id IN $ids DETACH DELETE n`,{ids:createdIds});
      await driver.close();await db.closeDatabase();
    }
    await new Promise<void>(resolve=>io.close(()=>resolve()));
  },40000);
  it('requires direct sign-in and validates creation without exposing any directory',async()=>{
    expect((await request(app).get('/api/communities')).status).toBe(401);
    expect((await request(app).get('/api/communities').set('Authorization','Bearer oc_synthetic')).status).toBe(401);
    expect((await request(app).get('/api/communities').set('Authorization',`Bearer ${tokenFor('owner',{embedded:'unlinked'})}`)).status).toBe(403);
    expect((await post('/api/communities',{name:'   '})).status).toBe(400);
    const response=await post('/api/communities',{name:'Synthetic community',description:'A private umbrella of independent chats'});
    expect(response.status).toBe(201);expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({name:'Synthetic community',role:'owner',memberCount:1});
    communityId=response.body.id;announcementsId=response.body.announcementsId;createdIds.push(communityId,announcementsId);
    expect((await get('/api/communities','outsider')).body).toEqual([]);
    expect((await get(api(),'outsider')).status).toBe(404);
    expect((await get(`/api/chat/conversations/${announcementsId}`,'outsider')).status).toBe(404);
  });
  it('creates private hashed invites, joins idempotently, and adds only announcement membership',async()=>{
    const response=await post(api('/invites'),{});expect(response.status).toBe(201);token=response.body.token;
    const stored=await run(`MATCH (:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_INVITE]->(i) RETURN properties(i) AS props`,{communityId});
    expect(stored.records[0]!.get('props')).not.toHaveProperty('token');expect(JSON.stringify(stored.records[0]!.get('props'))).not.toContain(token);
    expect((await post('/api/communities/join',{token:'invalid'},'outsider')).status).toBe(404);
    const replies=await Promise.all([join('member'),join('member')]);expect(replies.map(r=>r.status)).toEqual([200,200]);
    expect((await join('admin')).status).toBe(200);
    const memberships=await run(`MATCH (:User {id:$member})-[r:PARTICIPATES_IN]->(c) RETURN collect(c.id) AS ids`,{member:id('member')});
    expect(memberships.records[0]!.get('ids')).toEqual([announcementsId]);
    expect((await get(api(),'member')).body).toMatchObject({role:'member',memberCount:3,groups:[]});
    const co=(await get(`/api/chat/conversations/${announcementsId}`,'member')).body;expect(co.canPost).toBe(false);
    expect((await get(`/api/chat/conversations/${announcementsId}`)).body.canPost).toBe(true);
  });
  it('requires admin authority, group ownership and explicit consent before linking private history',async()=>{
    expect((await post(api('/groups'),{title:'No authority'},'member')).status).toBe(403);
    const created=await post(api('/groups'),{title:'Synthetic subgroup'});expect(created.status).toBe(201);
    groupId=created.body.conversationId;createdIds.push(groupId);
    expect((await get(api(),'member')).body.groups).toEqual([{id:groupId,title:'Synthetic subgroup',joined:false}]);
    expect((await get(`/api/chat/conversations/${groupId}/messages`,'member')).status).toBe(404);
    const existing=id('existing'),managed=id('managed'),foreign=id('foreign');createdIds.push(existing,managed,foreign);
    await run(`MATCH (u:User {id:$owner}),(f:User {id:$outsider})
      CREATE (c:Conversation {id:$existing,type:'group',title:'Existing private group',fixture:$fixture}),
        (m:Conversation {id:$managed,type:'group',title:'Unlinked managed group',unlinkedGroupId:'synthetic-group',fixture:$fixture}),
        (x:Conversation {id:$foreign,type:'group',title:'Foreign group',fixture:$fixture})
      CREATE (u)-[:PARTICIPATES_IN {role:'owner'}]->(c),(u)-[:PARTICIPATES_IN {role:'owner'}]->(m),
        (u)-[:PARTICIPATES_IN {role:'member'}]->(x),(f)-[:PARTICIPATES_IN {role:'owner'}]->(x)`,{owner:id('owner'),outsider:id('outsider'),existing,managed,foreign});
    expect((await post(api('/groups/link'),{conversationId:existing})).status).toBe(400);
    expect((await post(api('/groups/link'),{conversationId:managed,allowCommunityJoin:true})).status).toBe(409);
    expect((await post(api('/groups/link'),{conversationId:foreign,allowCommunityJoin:true})).status).toBe(403);
    expect((await post(api('/groups/link'),{conversationId:existing,allowCommunityJoin:true})).status).toBe(201);
    expect((await get(`/api/chat/conversations/${existing}`,'member')).status).toBe(404);
    expect((await post(api(`/groups/${groupId}/join`),{},'outsider')).status).toBe(404);
    expect((await post(api(`/groups/${groupId}/join`),{},'member')).status).toBe(200);
    expect((await post(api(`/groups/${groupId}/join`),{},'member')).status).toBe(200);
    expect((await get(`/api/chat/conversations/${groupId}`,'member')).status).toBe(200);
    const detail=(await get(api(),'member')).body;expect(detail.groups.find((g:{id:string})=>g.id===groupId)).toEqual({id:groupId,title:'Synthetic subgroup',joined:true});
    expect(detail.groups[0]).not.toHaveProperty('lastMessage');expect(detail.groups[0]).not.toHaveProperty('participants');
  });
  it('keeps announcement roster/invites managed by the community and blocks member posting, forwarding and internal sends',async()=>{
    const url=`/api/chat/conversations/${announcementsId}`;
    expect((await post(`${url}/messages`,{content:'Member must not post'},'member')).status).toBe(403);
    expect((await post(`${url}/participants`,{userId:id('outsider')})).status).toBe(409);
    expect((await post(`${url}/invites`,{})).status).toBe(409);
    const published=await post(`${url}/messages`,{content:'Synthetic announcement'});expect(published.status).toBe(201);
    createdIds.push(published.body.id);
    const read=await get(`${url}/messages`,'member');expect(read.status).toBe(200);expect(read.body.messages.some((m:{content:string})=>m.content==='Synthetic announcement')).toBe(true);
    const source=await post(`/api/chat/conversations/${groupId}/messages`,{content:'Synthetic subgroup source'},'member');expect(source.status).toBe(201);
    expect((await post(`/api/chat/messages/${source.body.id}/forward`,{toConversationId:announcementsId},'member')).status).toBe(403);
    const assistant=await import('../src/services/assistant.js');
    await expect(assistant.persistMessage(undefined,id('member'),announcementsId,'Internal bypass attempt')).resolves.toBeNull();
    const automatic=await import('../src/services/profileAgent.js');
    await expect(automatic.postAutomaticMessage(driver,{ownerId:id('member'),conversationId:announcementsId,replyToId:published.body.id,content:'Automatic bypass',props:{},idempotencyKey:id('auto')})).resolves.toBeNull();
    expect((await post(`/api/chat/messages/${published.body.id}/reactions`,{emoji:'👍'},'member')).status).toBe(201);
  },20000);
  it('serializes role changes with sends; stale admin permission cannot post after demotion',async()=>{
    const promote=await request(app).patch(api(`/members/${id('admin')}`)).set('Authorization',auth()).send({role:'admin'});expect(promote.status).toBe(200);
    expect((await post(`/api/chat/conversations/${announcementsId}/messages`,{content:'Admin announcement'},'admin')).status).toBe(201);
    expect((await request(app).patch(api(`/members/${id('member')}`)).set('Authorization',auth('admin')).send({role:'admin'})).status).toBe(403);
    const s=driver.session(),tx=s.beginTransaction();
    await tx.run(`MATCH (c:Conversation {id:$id}) SET c.contextAclRevision=coalesce(c.contextAclRevision,0)+1`,{id:announcementsId});
    const demote=request(app).patch(api(`/members/${id('admin')}`)).set('Authorization',auth()).send({role:'member'}).then(r=>r);
    await tx.commit();await s.close();expect((await demote).status).toBe(200);
    expect((await post(`/api/chat/conversations/${announcementsId}/messages`,{content:'Must not persist after demotion'},'admin')).status).toBe(403);
    const stored=await run(`MATCH (m:Message {conversationId:$id,content:'Must not persist after demotion'}) RETURN count(m) AS n`,{id:announcementsId});expect(Number(stored.records[0]!.get('n'))).toBe(0);
  });
  it('keeps shared Context writes admin-only and rechecks persisted agent scopes and revocation',async()=>{
    const {checkContextReadAccess,checkContextWriteAccess}=await import('../src/services/contextAccess.js');
    const key=id('agent-key');createdIds.push(key);
    await run(`CREATE (:AgentKey {id:$key,ownerUserId:$owner,scopes:['read','write'],fixture:$fixture})`,{key,owner:id('owner')});
    const s=driver.session();
    try {
      await s.executeWrite(async tx=>{
        expect(await checkContextReadAccess(tx,id('member'),announcementsId)).toBe(true);
        expect(await checkContextWriteAccess(tx,id('member'),announcementsId)).toBe(false);
        expect(await checkContextWriteAccess(tx,id('owner'),announcementsId,key,['read'])).toBe(false);
        expect(await checkContextWriteAccess(tx,id('owner'),announcementsId,key,['read','write'])).toBe(true);
        await tx.run(`MATCH (k:AgentKey {id:$key}) SET k.revokedAt=datetime()`,{key});
        expect(await checkContextWriteAccess(tx,id('owner'),announcementsId,key,['read','write'])).toBe(false);
      });
    } finally { await s.close(); }
  });
  it('enforces socket send authority and stops content delivery after community leave',async()=>{
    const sock:Socket=connect(socketUrl,{auth:{token:tokenFor('member')},transports:['websocket'],forceNew:true});
    await new Promise<void>((resolve,reject)=>{sock.once('connect',()=>resolve());sock.once('connect_error',reject);});
    const ack=await new Promise<{error?:string}>(resolve=>sock.emit('message:send',{conversationId:announcementsId,content:'Socket bypass'},resolve));
    expect(ack.error).toContain('Only community admins');
    const messages:unknown[]=[];sock.on('message:new',m=>messages.push(m));
    const removed=await request(app).delete(api(`/members/${id('member')}`)).set('Authorization',auth('member'));expect(removed.status).toBe(200);
    expect((await get(api(),'member')).status).toBe(404);
    expect((await get(`/api/chat/conversations/${announcementsId}/messages`,'member')).status).toBe(404);
    expect((await get(`/api/chat/conversations/${groupId}`,'member')).status).toBe(200); // independent membership retained
    expect((await post(`/api/chat/conversations/${announcementsId}/messages`,{content:'After leave'})).status).toBe(201);
    await new Promise(resolve=>setTimeout(resolve,60));expect(messages).toEqual([]);sock.disconnect();
  });
  it('invalidates revoked, replaced, expired and blocked invitations without leaking community metadata',async()=>{
    expect((await join('member')).status).toBe(200);
    const old=token;token=(await post(api('/invites'),{})).body.token;
    expect((await post('/api/communities/join',{token:old},'outsider')).status).toBe(404);
    await run(`MATCH (a:User {id:$owner}),(b:User {id:$blocked}) CREATE (a)-[:BLOCKED]->(b)`,{owner:id('owner'),blocked:id('blocked')});
    expect((await join('blocked')).status).toBe(404);
    await run(`MATCH (:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_INVITE]->(i) SET i.expiresAt=datetime()-duration('PT1S')`,{communityId});
    expect((await join('outsider')).status).toBe(404);
    token=(await post(api('/invites'),{})).body.token;
    expect((await request(app).delete(api('/invites')).set('Authorization',auth())).status).toBe(200);
    expect((await join('outsider')).status).toBe(404);
    token=(await post(api('/invites'),{})).body.token;
    expect((await request(app).delete(api(`/members/${id('member')}`)).set('Authorization',auth())).status).toBe(200);
    expect((await join('member')).status).toBe(404); // removal revokes outstanding tokens
  });
  it('unlinks a directory entry without changing chat membership and transfers ownership explicitly',async()=>{
    expect((await request(app).delete(api(`/groups/${groupId}`)).set('Authorization',auth())).status).toBe(200);
    expect((await get(`/api/chat/conversations/${groupId}`,'member')).status).toBe(200);
    expect((await post(api(`/groups/${groupId}/join`),{},'admin')).status).toBe(404);
    expect((await request(app).delete(api(`/members/${id('owner')}`)).set('Authorization',auth())).status).toBe(409);
    expect((await request(app).patch(api(`/members/${id('admin')}`)).set('Authorization',auth()).send({role:'owner'})).status).toBe(200);
    expect((await get(api(),'admin')).body.role).toBe('owner');
    expect((await get(api())).body.role).toBe('admin');
    expect((await request(app).delete(api(`/members/${id('owner')}`)).set('Authorization',auth())).status).toBe(200);
    expect((await get(`/api/chat/conversations/${announcementsId}`)).status).toBe(404);
    expect((await get(`/api/chat/conversations/${groupId}`)).status).toBe(200);
  });
});
