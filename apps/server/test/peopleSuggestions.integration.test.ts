import { afterAll, beforeAll, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { PEOPLE_SUGGESTIONS_QUERY } from '../src/services/peopleSuggestions.js';

const uri = process.env.NEO4J_TEST_URI;
const run = uri ? it : it.skip;
const suffix = Math.random().toString(36).slice(2);
const id = (s: string) => `people-${s}-${suffix}`;
const issuer = 'https://id.ideaflow.app/api/auth';
let driver: Driver;
beforeAll(async () => {
  if (!uri) return;
  driver = neo4j.driver(uri, process.env.NEO4J_TEST_PASSWORD
    ? neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD) : undefined);
  const s = driver.session();
  try {
    await s.run(`CREATE (:User {id:$viewer, name:'Viewer'}), (:User {id:$other, name:'Other'})
      WITH 1 AS ignored UNWIND $people AS p CREATE (u:User) SET u=p`, {
      viewer: id('viewer'), other: id('other'), people: ['recent','old','empty','system','assistant','secretary','group','friend','stranger','hidden','email','blocked','blocker','bot'].map((key) => ({
        id:id(key), name:'Fixture '+key, ideaflowIssuer:issuer, ideaflowSub:id('subject-'+key),
        email:key+'@example.test', discoveryMode:['hidden','email'].includes(key) ? (key==='email'?'email_only':'hidden') : 'name', isBot:key==='bot',
      })),
    });
    for (const key of ['recent','old','empty','system','assistant','secretary','group','blocked','blocker','bot']) {
      await s.run(`MATCH (v:User {id:$viewer}), (u:User {id:$person})
        CREATE (c:Conversation {id:$conversation,type:$type,createdAt:datetime('2026-10-24T00:00:00Z'),lastMessageAt:datetime('2026-10-24T00:00:00Z')})
        CREATE (v)-[:PARTICIPATES_IN]->(c), (u)-[:PARTICIPATES_IN]->(c)`,
      { viewer:id('viewer'),person:id(key),conversation:id('dm-'+key),type:key==='group'?'group':'direct' });
      if (key !== 'empty') await s.run(`CREATE (m:Message {id:$id,conversationId:$conversation,senderId:$sender,messageType:$type,
        content:'Synthetic content-bearing message',createdAt:datetime($at),viaAssistant:$assistant,viaSecretary:$secretary})`, {
        id:id('message-'+key),conversation:id('dm-'+key),sender:id(key),type:key==='system'?'system':'text',
        at:key==='old'?'2026-01-01T00:00:00Z':'2026-10-01T00:00:00Z',assistant:key==='assistant',secretary:key==='secretary',
      });
    }
    await s.run(`MATCH (v:User {id:$viewer}), (b:User {id:$blocked}), (r:User {id:$blocker})
      CREATE (v)-[:BLOCKED]->(b), (r)-[:BLOCKED]->(v)
      CREATE (:OpenChatConnection {pairKey:$pair,state:'accepted'})`, {
      viewer:id('viewer'),blocked:id('blocked'),blocker:id('blocker'),pair:JSON.stringify([id('viewer'),id('friend')].sort()),
    });
    // A real participant message without IN_CONVERSATION must count, and a
    // later deleted message must not advance recency.
    await s.run(`CREATE (:Message {id:$id,conversationId:$conversation,senderId:$sender,messageType:'text',
      content:'Deleted synthetic message',createdAt:datetime('2026-10-24T00:00:00Z'),deletedAt:datetime()})`,
    {id:id('deleted'),conversation:id('dm-old'),sender:id('old')});
  } finally { await s.close(); }
});
afterAll(async () => {
  if (!driver) return;
  const s=driver.session();
  try { await s.run(`MATCH (n) WHERE n.id ENDS WITH $suffix OR (n:OpenChatConnection AND n.pairKey=$pair) DETACH DELETE n`,
    {suffix:'-'+suffix,pair:JSON.stringify([id('viewer'),id('friend')].sort())}); }
  finally {await s.close();await driver.close();}
});
async function ask(viewer='viewer', name='', email='', subjects:string[]=[]) {
  const s=driver.session({defaultAccessMode:'READ'});
  try { const result=await s.run(PEOPLE_SUGGESTIONS_QUERY,{userId:id(viewer),issuer,subjects,empty:!name&&!email&&subjects.length===0,name,email,limit:neo4j.int(100)});
    return result.records.map(r=>({...r.toObject(),lastChattedAt:r.get('lastChattedAt')===null?null:Number(r.get('lastChattedAt'))}));
  } finally {await s.close();}
}
run('counts only actual human direct messages, orders them before friendship-only and empty/group threads',async()=>{
  const rows=await ask();
  expect(rows.slice(0,3).map(r=>r.userId)).toEqual(['recent','old','friend'].map(id));
  expect(rows.find(r=>r.userId===id('recent'))).toMatchObject({chatted:true,connected:false,lastChattedAt:Date.parse('2026-10-01T00:00:00Z')});
  expect(rows.find(r=>r.userId===id('old'))?.lastChattedAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
  for(const key of ['empty','system','assistant','secretary','group']) expect(rows.find(r=>r.userId===id(key))).toMatchObject({chatted:false,connected:false,lastChattedAt:null});
  expect(rows.find(r=>r.userId===id('friend'))).toMatchObject({connected:true,chatted:false,lastChattedAt:null});
  for(const key of ['stranger','hidden','email','blocked','blocker','bot']) expect(rows.some(r=>r.userId===id(key))).toBe(false);
  expect(rows.every(r=>Object.keys(r).sort().join(',')==='chatted,connected,lastChattedAt,name,subject,userId')).toBe(true);
});
run('keeps discovery policy and mutual blocks, and never transfers another viewer relationship metadata',async()=>{
  const rows=await ask('viewer','fixture');
  expect(rows.some(r=>r.userId===id('stranger'))).toBe(true);
  for(const key of ['hidden','email','blocked','blocker','bot']) expect(rows.some(r=>r.userId===id(key))).toBe(false);
  expect((await ask('viewer','','email@example.test')).map(r=>r.userId)).toEqual([id('email')]);
  expect(await ask('other')).toEqual([]);
  expect((await ask('other','fixture recent'))[0]).toMatchObject({userId:id('recent'),connected:false,chatted:false,lastChattedAt:null});
});

run('candidate subjects never bypass mutual blocks or hidden/email-only discovery and cannot read another account chats',async()=>{
  const subjects=['recent','friend','stranger','hidden','email','blocked','blocker','bot'].map(key=>id('subject-'+key));
  const rows=await ask('viewer','','',subjects);
  expect(rows.map(r=>r.userId).sort()).toEqual(['recent','friend','stranger'].map(id).sort());
  const other=await ask('other','','',subjects);
  expect(other.every(r=>r.chatted===false&&r.connected===false&&r.lastChattedAt===null)).toBe(true);
  for(const key of ['hidden','email','bot']) expect(other.some(r=>r.userId===id(key))).toBe(false);
});
