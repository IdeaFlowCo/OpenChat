import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { createContextPost, updateContextPost, deleteContextPost, listContextPosts, reportContextPost } from '../src/services/contextLane.js';
import { contextAgentPreference, askContextAgents, listContextAgentRequests, respondToContextAgentRequest } from '../src/services/contextAgentRequests.js';
const integration = process.env.NEO4J_TEST_URI ? describe.sequential : describe.skip;
integration('quiet Context back-channel with real Neo4j', () => {
  let driver: Driver;
  const prefix=`context-${crypto.randomUUID()}`, a=`${prefix}-a`, b=`${prefix}-b`, room=`${prefix}-room`, key=`${prefix}-key`;
  let postId:string, replyId:string, requestId:string;
  const session = async <T>(fn:(s:any)=>Promise<T>) => {const s=driver.session();try{return await fn(s);}finally{await s.close();}};
  const run = (q:string,p:any={})=>session(s=>s.run(q,p)) as Promise<any>;
  const scopes=['read','write'];
  beforeAll(async()=>{
    driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j',process.env.NEO4J_TEST_PASSWORD || 'test'));
    await run(`CREATE (a:User {id:$a,name:'Alice'}),(b:User {id:$b,name:'Bob'}),
      (c:Conversation {id:$room,type:'group',lastMessageAt:'unchanged',lastMessagePreview:'hello'}),
      (k:AgentKey {id:$key,name:'Hermes',ownerUserId:$b,scopes:['read','write']})
      CREATE (a)-[:PARTICIPATES_IN {role:'owner',lastReadAt:'before'}]->(c), (b)-[:PARTICIPATES_IN {role:'member',lastReadAt:'before'}]->(c)`,{a,b,room,key});
  });
  afterAll(async()=>{
    await run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.targetId=$postId DETACH DELETE n`,{prefix,room,postId:postId || ''});
    await driver.close();
  });
  it('projects authors and agent attribution, replies and idempotency',async()=>{
    const post=await session(s=>createContextPost(s,a,room,{text:'@Bob #quiet #shared',clientRequestId:'root'}));
    expect(post.author).toEqual({id:a,name:'Alice'});expect(post.agent).toBeUndefined();postId=post.id;
    const input={text:'Reply from Hermes',clientRequestId:'reply',replyToId:post.id};
    const reply=await session(s=>createContextPost(s,b,room,input,key,scopes)); replyId=reply.id;
    expect(reply.agent).toEqual({id:key,name:'Hermes'});expect(reply.author.name).toBe('Bob');
    expect(reply.replyTo).toMatchObject({id:post.id,text:'@Bob #quiet #shared',author:{name:'Alice'}});
    expect(await session(s=>createContextPost(s,b,room,input,key,scopes))).toEqual(reply);
    await expect(session(s=>createContextPost(s,b,room,{...input,text:'Different'},key,scopes))).rejects.toMatchObject({statusCode:409});
    await expect(session(s=>createContextPost(s,a,room,{text:'bad',clientRequestId:'bad',replyToId:'other-room-post'}))).rejects.toMatchObject({statusCode:404});
  });
  it('validates edits, original retry digest, and case-insensitive search',async()=>{
    const edited=await session(s=>updateContextPost(s,b,room,replyId,'CHANGED reply',1,key,scopes));expect(edited.revision).toBe(2);expect(edited.agent?.name).toBe('Hermes');
    await expect(session(s=>updateContextPost(s,b,room,replyId,'',2,key,scopes))).rejects.toMatchObject({statusCode:400});
    await expect(session(s=>updateContextPost(s,b,room,replyId,'no',1,key,scopes))).rejects.toMatchObject({statusCode:409});
    expect((await session(s=>createContextPost(s,b,room,{text:'Reply from Hermes',clientRequestId:'reply',replyToId:postId},key,scopes))).text).toBe('CHANGED reply');
    expect((await session(s=>listContextPosts(s,a,room,{search:'changed'}))).posts.map(p=>p.id)).toEqual([replyId]);
  });
  it('paginates tied timestamps and rejects invalid cursors and outsiders',async()=>{
    await run(`MATCH (t:Thought {conversationId:$room}) SET t.createdAt=datetime('2026-01-01T00:00:00Z')`,{room});
    const first=await session(s=>listContextPosts(s,a,room,{limit:1}));expect(first.nextCursor).toBeTruthy();
    const second=await session(s=>listContextPosts(s,a,room,{limit:1,cursor:first.nextCursor}));
    expect(new Set([...first.posts,...second.posts].map(p=>p.id)).size).toBe(2);expect(second.nextCursor).toBeUndefined();
    await expect(session(s=>listContextPosts(s,a,room,{cursor:'nonsense'}))).rejects.toMatchObject({statusCode:400});
    await expect(session(s=>listContextPosts(s,a,room,{limit:-1}))).rejects.toMatchObject({statusCode:400});
    await expect(session(s=>listContextPosts(s,'outsider',room))).rejects.toMatchObject({statusCode:403});
  });
  it('reports visible posts once and denies outsider reports',async()=>{
    const report=await session(s=>reportContextPost(s,b,room,postId,'spam'));expect(report.id).toBeTruthy();
    expect(await session(s=>reportContextPost(s,b,room,postId,'spam'))).toEqual(report);
    await expect(session(s=>reportContextPost(s,'outsider',room,postId,'spam'))).rejects.toMatchObject({statusCode:403});
  });
  it('requires opt-in and deduplicates per source revision',async()=>{
    await expect(session(s=>askContextAgents(s,a,room,postId))).rejects.toMatchObject({statusCode:409});
    expect(await session(s=>contextAgentPreference(s,b,key,true))).toEqual({enabled:true});
    await expect(session(s=>contextAgentPreference(s,a,key,true))).rejects.toMatchObject({statusCode:404});
    expect(await session(s=>askContextAgents(s,a,room,postId))).toEqual({queued:1,available:1});
    expect(await session(s=>askContextAgents(s,a,room,postId))).toEqual({queued:0,available:1});
    const inbox=await session(s=>listContextAgentRequests(s,b,key));expect(inbox.requests).toHaveLength(1);requestId=inbox.requests[0].id;
    expect(inbox.requests[0].text).toBe('@Bob #quiet #shared');
    await expect(session(s=>listContextAgentRequests(s,a,key))).rejects.toMatchObject({statusCode:403});
  });
  it('withholds blocked requests, completes and retries one shared reply',async()=>{
    await run(`MATCH (a:User {id:$a}), (b:User {id:$b}) CREATE (a)-[:BLOCKED]->(b)`,{a,b});
    expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(0);
    await run(`MATCH (:User {id:$a})-[r:BLOCKED]->(:User {id:$b}) DELETE r`,{a,b});
    const response=await session(s=>respondToContextAgentRequest(s,b,key,scopes,requestId,'Approved shared answer'));
    expect(response.status).toBe('completed');expect(response.post?.replyToId).toBe(postId);
    expect((await session(s=>respondToContextAgentRequest(s,b,key,scopes,requestId,'Approved shared answer'))).post?.id).toBe(response.post?.id);
    expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(0);
  });
  it('invalidates pending requests on edit, opt-out, scope change, revocation and removal',async()=>{
    const source=await session(s=>createContextPost(s,a,room,{text:'Second request',clientRequestId:'second'}));
    await session(s=>askContextAgents(s,a,room,source.id));
    expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(1);
    await session(s=>updateContextPost(s,a,room,source.id,'Edited request',1));
    expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(0);
    await session(s=>askContextAgents(s,a,room,source.id));
    const pending=(await session(s=>listContextAgentRequests(s,b,key))).requests[0];
    await session(s=>contextAgentPreference(s,b,key,false));
    await expect(session(s=>listContextAgentRequests(s,b,key))).rejects.toMatchObject({statusCode:403});
    await session(s=>contextAgentPreference(s,b,key,true));
    for(const mutation of ["k.scopes=['read']", "k.scopes=['read','write'],k.revokedAt='revoked'", "k.revokedAt=null,k.expiresAt='2000-01-01T00:00:00Z'"]) {
      await run(`MATCH (k:AgentKey {id:$key}) SET ${mutation}`,{key});
      await expect(session(s=>listContextAgentRequests(s,b,key))).rejects.toMatchObject({statusCode:403});
      await expect(session(s=>respondToContextAgentRequest(s,b,key,scopes,pending.id,'Denied'))).rejects.toMatchObject({statusCode:404});
    }
    await run(`MATCH (k:AgentKey {id:$key}) SET k.expiresAt=null`,{key});
    await run(`MATCH (:User {id:$b})-[p:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE p`,{b,room});
    expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(0);
    await expect(session(s=>respondToContextAgentRequest(s,b,key,scopes,pending.id,'Denied'))).rejects.toMatchObject({statusCode:404});
    await run(`MATCH (b:User {id:$b}),(c:Conversation {id:$room}) CREATE (b)-[:PARTICIPATES_IN {role:'member',lastReadAt:'before'}]->(c)`,{b,room});
    expect(await session(s=>respondToContextAgentRequest(s,b,key,scopes,pending.id,undefined,true))).toEqual({status:'declined'});
  });
  it('serializes concurrent create and request retries',async()=>{
    const input={text:'Concurrent post',clientRequestId:'concurrent'};
    const posts=await Promise.all([session(s=>createContextPost(s,a,room,input)),session(s=>createContextPost(s,a,room,input))]);
    expect(posts[0].id).toBe(posts[1].id);
    const asks=await Promise.all([session(s=>askContextAgents(s,a,room,posts[0].id)),session(s=>askContextAgents(s,a,room,posts[0].id))]);
    expect(asks.reduce((sum,r)=>sum+r.queued,0)).toBe(1);
  });
  it('deletes body while preserving threads, prevents resurrection',async()=>{
    await session(s=>deleteContextPost(s,a,room,postId));
    const posts=(await session(s=>listContextPosts(s,b,room,{},key,scopes))).posts;
    expect(posts.find(p=>p.id===postId)).toMatchObject({text:'',isDeleted:true});
    expect(posts.find(p=>p.id===replyId)?.replyTo).toMatchObject({id:postId,text:'',isDeleted:true});
    expect((await session(s=>createContextPost(s,a,room,{text:'@Bob #quiet #shared',clientRequestId:'root'}))).isDeleted).toBe(true);
    await expect(session(s=>updateContextPost(s,a,room,postId,'resurrect',2))).rejects.toMatchObject({statusCode:404});
    await expect(session(s=>askContextAgents(s,a,room,postId))).rejects.toMatchObject({statusCode:404});
  });
  it('leaves main chat state unchanged for the full lifecycle',async()=>{
    const snapshot=await run(`MATCH (c:Conversation {id:$room})<- [p:PARTICIPATES_IN]-(u:User)
      OPTIONAL MATCH (m:Message {conversationId:$room})
      RETURN c.lastMessageAt AS at,c.lastMessagePreview AS preview,collect(DISTINCT p.lastReadAt) AS reads,count(m) AS messages`,{room});
    const row=snapshot.records[0];expect(row.get('at')).toBe('unchanged');expect(row.get('preview')).toBe('hello');expect(row.get('reads')).toEqual(['before']);expect(Number(row.get('messages'))).toBe(0);
    await run(`CREATE (:Message {id:$id,conversationId:$room,text:'Normal delivery control'})`,{id:`${prefix}-control`,room});
    expect(Number((await run(`MATCH (m:Message {conversationId:$room}) RETURN count(m) AS n`,{room})).records[0].get('n'))).toBe(1);
  });
});
