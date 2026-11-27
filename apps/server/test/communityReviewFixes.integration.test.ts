import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j,{type Driver} from 'neo4j-driver';
import request from 'supertest';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const {NEO4J_TEST_URI:uri,NEO4J_TEST_USER:user,NEO4J_TEST_PASSWORD:password}=process.env;
const integration=uri&&user&&password?describe.sequential:describe.skip;
integration('community review regressions: shared mutations and account lifecycle',{timeout:30000},()=>{
  const prefix=`community-fixes-${Date.now()}-${Math.random().toString(36).slice(2)}`,ids:string[]=[],owners:string[]=[];
  let driver:Driver,db:typeof import('../src/db.js');const app=express().use(express.json());
  const auth=(id:string)=>'Bearer '+jwt.sign({userId:id,email:'synthetic@example.test'},process.env.JWT_SECRET||'dev-secret-change-me');
  const run=async(q:string,p:Record<string,unknown>={})=>{const s=driver.session();try{return await s.run(q,p);}finally{await s.close();}};
  const post=(url:string,body:unknown,uid:string)=>request(app).post(url).set('Authorization',auth(uid)).send(body);
  beforeAll(async()=>{
    process.env.NEO4J_URI=uri!;process.env.NEO4J_USER=user!;process.env.NEO4J_PASSWORD=password!;
    db=await import('../src/db.js');driver=neo4j.driver(uri!,neo4j.auth.basic(user!,password!));
    app.use('/api/communities',(await import('../src/routes/communities.js')).default);
    app.use('/api/chat',(await import('../src/routes/chat.js')).default);
    app.use('/api/auth',(await import('../src/routes/auth.js')).default);
    app.use('/api/thoughts',(await import('../src/routes/thoughts.js')).default);
    app.use('/api/chat',(await import('../src/routes/conversationContent.js')).default);
  },40000);
  afterAll(async()=>{if(driver){await run(`MATCH(co:OpenChatCommunity) WHERE co.id IN $ids OPTIONAL MATCH(co)-[:HAS_OPENCHAT_INVITE]->(i) DETACH DELETE i`,{ids});
    await run(`MATCH(n) WHERE n.id STARTS WITH $prefix OR n.id IN $ids OR n.conversationId IN $ids OR n.userId IN $owners DETACH DELETE n`,{prefix,ids,owners});await driver.close();await db.closeDatabase();}},40000);
  async function fixture(name:string,role:'admin'|'member'|'none'='admin'){
    const owner=`${prefix}-${name}-owner`,member=`${prefix}-${name}-member`,outsider=`${prefix}-${name}-outsider`;owners.push(owner,member,outsider);
    await run(`UNWIND $users AS id CREATE(:User {id:id,name:id})`,{users:[owner,member,outsider]});
    const created=await post('/api/communities',{name:'Synthetic '+name},owner);expect(created.status).toBe(201);const co=created.body;ids.push(co.id,co.announcementsId);
    const invited=await post(`/api/communities/${co.id}/invites`,{},owner);expect(invited.status).toBe(201);const token=invited.body.token;
    if(role!=='none'){expect((await post('/api/communities/join',{token},member)).status).toBe(200);
      if(role==='admin')expect((await request(app).patch(`/api/communities/${co.id}/members/${member}`).set('Authorization',auth(owner)).send({role:'admin'})).status).toBe(200);}
    return {owner,member,outsider,co,token};
  }
  it('refuses demoted/removed admin deletion while retaining normal chat deletion behavior',async()=>{
    const f=await fixture('deletion'),messages=[];
    for(let n=0;n<2;n++){const r=await post(`/api/chat/conversations/${f.co.announcementsId}/messages`,{content:'Protected announcement '+n},f.member);expect(r.status).toBe(201);messages.push(r.body.id);}
    await request(app).patch(`/api/communities/${f.co.id}/members/${f.member}`).set('Authorization',auth(f.owner)).send({role:'member'});
    expect((await request(app).delete(`/api/chat/messages/${messages[0]}`).set('Authorization',auth(f.member))).status).toBe(403);
    await request(app).delete(`/api/communities/${f.co.id}/members/${f.member}`).set('Authorization',auth(f.owner));
    expect((await request(app).delete(`/api/chat/messages/${messages[1]}`).set('Authorization',auth(f.member))).status).toBe(403);
    const untouched=await run(`MATCH(m:Message) WHERE m.id IN $ids RETURN collect(m.deletedAt) AS deleted`,{ids:messages});expect(untouched.records[0]!.get('deleted')).toEqual([]);
    const group=await post('/api/chat/conversations',{type:'group',title:'Ordinary group',participantIds:[f.member]},f.owner);expect(group.status).toBe(201);ids.push(group.body.id);
    const normal=await post(`/api/chat/conversations/${group.body.id}/messages`,{content:'Legacy normal message'},f.member);expect(normal.status).toBe(201);
    await request(app).delete(`/api/chat/conversations/${group.body.id}/participants/${f.member}`).set('Authorization',auth(f.owner));
    expect((await request(app).delete(`/api/chat/messages/${normal.body.id}`).set('Authorization',auth(f.member))).status).toBe(200);
  });
  it('preserves private captures/statuses but blocks every explicit member pin path',async()=>{
    const f=await fixture('sharing','member');
    const message=await post(`/api/chat/conversations/${f.co.announcementsId}/messages`,{content:'Synthetic announcement source'},f.owner);expect(message.status).toBe(201);
    const privateEntry=await post('/api/thoughts',{text:'Member private capture',scopeConversationId:f.co.announcementsId},f.member);expect(privateEntry.status).toBe(201);ids.push(privateEntry.body.id);
    expect((await request(app).patch('/api/thoughts/'+privateEntry.body.id).set('Authorization',auth(f.member)).send({text:'Private edited capture'})).status).toBe(200);
    expect((await post(`/api/thoughts/${privateEntry.body.id}/pin`,{conversationId:f.co.announcementsId,expectedText:'Private edited capture'},f.member)).status).toBe(403);
    expect((await post('/api/thoughts',{text:'Must not share',pinToConversationId:f.co.announcementsId},f.member)).status).toBe(403);
    const statusUrl='/api/chat/message-status?messageId='+encodeURIComponent(message.body.id);
    expect((await request(app).put(statusUrl).set('Authorization',auth(f.member)).send({status:'open',visibility:'private'})).status).toBe(200);
    expect((await request(app).put(statusUrl).set('Authorization',auth(f.member)).send({status:'open',visibility:'chat'})).status).toBe(403);
    const shared=await request(app).get(`/api/chat/conversations/${f.co.announcementsId}/content`).set('Authorization',auth(f.owner));expect(shared.status).toBe(200);
    expect(shared.body.items.some((item:{visibility:string;thought?:{text:string}})=>item.visibility==='conversation'&&['Private edited capture','Must not share'].includes(item.thought?.text??''))).toBe(false);
    await request(app).patch(`/api/communities/${f.co.id}/members/${f.member}`).set('Authorization',auth(f.owner)).send({role:'admin'});
    expect((await post(`/api/thoughts/${privateEntry.body.id}/pin`,{conversationId:f.co.announcementsId,expectedText:'Private edited capture'},f.member)).status).toBe(200);
    const direct=await post('/api/thoughts',{text:'Reviewed admin pin',pinToConversationId:f.co.announcementsId},f.member);expect(direct.status).toBe(201);ids.push(direct.body.id);
    expect((await request(app).put(statusUrl).set('Authorization',auth(f.member)).send({status:'closed',visibility:'chat'})).status).toBe(200);
    await request(app).patch(`/api/communities/${f.co.id}/members/${f.member}`).set('Authorization',auth(f.owner)).send({role:'member'});
    expect((await request(app).patch('/api/thoughts/'+privateEntry.body.id).set('Authorization',auth(f.member)).send({text:'Disallowed shared edit'})).status).toBe(403);
    expect((await request(app).delete('/api/thoughts/'+privateEntry.body.id).set('Authorization',auth(f.member))).status).toBe(403);
    expect((await request(app).delete(`/api/thoughts/${privateEntry.body.id}/pin/${f.co.announcementsId}`).set('Authorization',auth(f.member))).status).toBe(403);
    expect((await request(app).put(statusUrl).set('Authorization',auth(f.member)).send({status:'open',visibility:'private'})).status).toBe(403);
    await request(app).delete(`/api/communities/${f.co.id}/members/${f.member}`).set('Authorization',auth(f.owner));
    expect((await request(app).patch('/api/thoughts/'+direct.body.id).set('Authorization',auth(f.member)).send({text:'After removal'})).status).toBe(403);
    const privateAfter=await post('/api/thoughts',{text:'Still private'},f.member);expect(privateAfter.status).toBe(201);ids.push(privateAfter.body.id);
    expect((await request(app).patch('/api/thoughts/'+privateAfter.body.id).set('Authorization',auth(f.member)).send({text:'Private remains editable'})).status).toBe(200);
    expect((await request(app).delete('/api/thoughts/'+privateAfter.body.id).set('Authorization',auth(f.member))).status).toBe(204);
  });
  it('passes account-owner authority only to an existing admin, revokes old invites and preserves child history',async()=>{
    const f=await fixture('successor');const group=await post(`/api/communities/${f.co.id}/groups`,{title:'Independent child'},f.owner);expect(group.status).toBe(201);ids.push(group.body.conversationId);
    expect((await post(`/api/communities/${f.co.id}/groups/${group.body.conversationId}/join`,{},f.member)).status).toBe(200);
    const source=await post(`/api/chat/conversations/${group.body.conversationId}/messages`,{content:'Child history'},f.member);expect(source.status).toBe(201);
    expect((await request(app).delete('/api/auth/me').set('Authorization',auth(f.owner))).status).toBe(204);
    const co=await request(app).get('/api/communities/'+f.co.id).set('Authorization',auth(f.member));expect(co.status).toBe(200);expect(co.body).toMatchObject({role:'owner',state:'active'});
    expect((await post('/api/communities/join',{token:f.token},f.outsider)).status).toBe(404);
    const fresh=await post(`/api/communities/${f.co.id}/invites`,{},f.member);expect(fresh.status).toBe(201);
    expect((await post('/api/communities/join',{token:fresh.body.token},f.outsider)).status).toBe(200);
    expect((await request(app).patch(`/api/communities/${f.co.id}/members/${f.outsider}`).set('Authorization',auth(f.member)).send({role:'admin'})).status).toBe(200);
    const history=await request(app).get(`/api/chat/conversations/${group.body.conversationId}/messages`).set('Authorization',auth(f.member));expect(history.status).toBe(200);expect(history.body.messages.some((m:{content:string})=>m.content==='Child history')).toBe(true);
  });
  it('archives rather than promoting an ordinary member, and closes sole-owner invites',async()=>{
    for(const role of ['member','none'] as const){
      const f=await fixture('archive-'+role,role);expect((await request(app).delete('/api/auth/me').set('Authorization',auth(f.owner))).status).toBe(204);
      const stored=await run(`MATCH(co:OpenChatCommunity {id:$id}) OPTIONAL MATCH(:User)-[r:IN_OPENCHAT_COMMUNITY]->(co) WHERE r.role='owner' RETURN co.state AS state,count(r) AS owners`,{id:f.co.id});
      expect(stored.records[0]!.get('state')).toBe('archived');expect(Number(stored.records[0]!.get('owners'))).toBe(0);
      expect((await post('/api/communities/join',{token:f.token},f.outsider)).status).toBe(404);
      if(role==='member'){
        const detail=await request(app).get('/api/communities/'+f.co.id).set('Authorization',auth(f.member));expect(detail.body).toMatchObject({state:'archived',role:'member'});
        expect((await post(`/api/chat/conversations/${f.co.announcementsId}/messages`,{content:'Archived shared write'},f.member)).status).toBe(403);
        expect((await request(app).delete(`/api/communities/${f.co.id}/members/${f.member}`).set('Authorization',auth(f.member))).status).toBe(200);
      }
    }
  });
  it('takes the author User fence before the announcement while account deletion holds that User',async()=>{
    const f=await fixture('automatic-lock');
    const source=await post(`/api/chat/conversations/${f.co.announcementsId}/messages`,{content:'Automatic synthetic source'},f.member);expect(source.status).toBe(201);
    const {prepareCommunityAccountDeletion}=await import('../src/services/communities.js');
    const {postAutomaticMessage}=await import('../src/services/profileAgent.js');
    let entered!:(value:'user'|'conversation')=>void,observed=false,conversationLocked=false;
    const first=new Promise<'user'|'conversation'>(resolve=>{entered=resolve;});
    const instrumented={session:()=>{const child=driver.session();return {close:()=>child.close(),executeWrite:(fn:any)=>child.executeWrite(async actual=>fn({run:async(q:string,p:any)=>{
      const userFence=q.includes('SET u.contextAclRevision'),chatFence=q.includes('SET c.contextAclRevision');
      if(!observed&&(userFence||chatFence)){observed=true;entered(userFence?'user':'conversation');}
      const result=await actual.run(q,p);if(chatFence)conversationLocked=true;return result;
    }}))};}} as unknown as Driver;
    const s=driver.session(),tx=s.beginTransaction();let automatic:ReturnType<typeof postAutomaticMessage>|undefined;
    try{
      await tx.run(`MATCH(u:User {id:$id}) SET u.contextAclRevision=coalesce(u.contextAclRevision,0)+1`,{id:f.member});
      automatic=postAutomaticMessage(instrumented,{ownerId:f.member,conversationId:f.co.announcementsId,replyToId:source.body.id,content:'Automatic synthetic reply',props:{},idempotencyKey:prefix+'-automatic'});
      expect(await first).toBe('user');await new Promise(resolve=>setTimeout(resolve,75));expect(conversationLocked).toBe(false);
      await prepareCommunityAccountDeletion(tx,f.member);await tx.rollback();expect(await automatic).not.toBeNull();
    }finally{await tx.close();await Promise.allSettled(automatic?[automatic]:[]);await s.close();}
  });
  it('settles a real managed account deletion concurrent with automatic posting and redacts any earlier committed reply',async()=>{
    const f=await fixture('automatic-delete'),source=await post(`/api/chat/conversations/${f.co.announcementsId}/messages`,{content:'Source before deletion'},f.owner);expect(source.status).toBe(201);
    const {postAutomaticMessage}=await import('../src/services/profileAgent.js');
    const [deleted]=await Promise.all([
      request(app).delete('/api/auth/me').set('Authorization',auth(f.owner)),
      postAutomaticMessage(driver,{ownerId:f.owner,conversationId:f.co.announcementsId,replyToId:source.body.id,content:'Must not outlive account deletion',props:{},idempotencyKey:prefix+'-delete-auto'}),
    ]);
    expect(deleted.status).toBe(204);
    const remaining=await run(`OPTIONAL MATCH(u:User {id:$owner}) WITH count(u) AS users OPTIONAL MATCH(m:Message {senderId:$owner}) RETURN users,collect(m.content) AS content`,{owner:f.owner});
    expect(Number(remaining.records[0]!.get('users'))).toBe(0);expect(remaining.records[0]!.get('content')).not.toContain('Must not outlive account deletion');
    const detail=await request(app).get('/api/communities/'+f.co.id).set('Authorization',auth(f.member));expect(detail.body).toMatchObject({role:'owner',state:'active'});
  });
  it('does not invert account-deletion locks in the internal assistant announcement writer',async()=>{
    const f=await fixture('assistant-lock');
    const {prepareCommunityAccountDeletion}=await import('../src/services/communities.js');
    const {persistMessage}=await import('../src/services/assistant.js');
    const s=driver.session(),tx=s.beginTransaction();let automatic:ReturnType<typeof persistMessage>|undefined;
    try{
      await tx.run(`MATCH(u:User {id:$id}) SET u.contextAclRevision=coalesce(u.contextAclRevision,0)+1`,{id:f.member});
      let finished=false;automatic=persistMessage(undefined,f.member,f.co.announcementsId,'Synthetic internal announcement').then(value=>{finished=true;return value;});
      await new Promise(resolve=>setTimeout(resolve,75));expect(finished).toBe(false);
      await prepareCommunityAccountDeletion(tx,f.member);await tx.rollback();expect(await automatic).not.toBeNull();
    }finally{await tx.close();await Promise.allSettled(automatic?[automatic]:[]);await s.close();}
  });
  it('serializes ownership transfer with owner account deletion without leaving an active ownerless community',async()=>{
    const f=await fixture('owner-race');
    expect((await post('/api/communities/join',{token:f.token},f.outsider)).status).toBe(200);
    const [transfer,deleted]=await Promise.all([
      request(app).patch(`/api/communities/${f.co.id}/members/${f.outsider}`).set('Authorization',auth(f.owner)).send({role:'owner'}),
      request(app).delete('/api/auth/me').set('Authorization',auth(f.owner)),
    ]);
    expect([200,403,404]).toContain(transfer.status);expect(deleted.status).toBe(204);
    const result=await run(`MATCH(co:OpenChatCommunity {id:$id}) MATCH(u:User)-[r:IN_OPENCHAT_COMMUNITY]->(co) WHERE r.role='owner' RETURN u.id AS id,co.state AS state`,{id:f.co.id});
    expect(result.records).toHaveLength(1);expect([f.member,f.outsider]).toContain(result.records[0]!.get('id'));expect(result.records[0]!.get('state')).toBe('active');
  });
});
