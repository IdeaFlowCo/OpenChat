import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j,{type Driver,type Session} from 'neo4j-driver';
import { addCapture, authenticateCaptureDevice, captureKeys, createCaptureDevice, forgetCapture, ingestCaptures, listCaptures, listCaptureThreads, parseCapture, updateCapture } from '../src/services/messageCaptures.js';
const integration=process.env.NEO4J_TEST_URI?describe.sequential:describe.skip;
const example={channel:'imessage',sourceAccount:'test',sourceThreadId:'chat-a',threadTitle:'Example person',participants:['person@example.test'],sourceMessageId:'message-a',triggerMessageId:'reply-a',text:'An article to read',triggerText:'#longevity',sourceAt:'2026-10-01T00:00:00Z',capturedAt:'2026-10-02T00:00:00Z',tags:['longevity'],pinned:false,destination:'stream',captureMethod:'reply'};
integration('private capture persistence',()=>{
  let driver:Driver;const owner='capture-test-'+crypto.randomUUID(),other=owner+'-other';
  const use=async<T>(fn:(s:Session)=>Promise<T>)=>{const s=driver.session();try{return await fn(s);}finally{await s.close();}};
  const read=()=>use(s=>listCaptures(s,owner));
  beforeAll(async()=>{driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER||'neo4j',process.env.NEO4J_TEST_PASSWORD||'test'));await use(s=>s.run('CREATE (:User {id:$owner}),(:User {id:$other})',{owner,other}));});
  afterAll(async()=>{await use(s=>s.run('MATCH (n) WHERE n.ownerId IN [$owner,$other] OR n.id IN [$owner,$other] DETACH DELETE n',{owner,other}));await driver.close();});
  it('replays once, unions new event tags, and never adds a shared Thought or Message',async()=>{
    await use(s=>ingestCaptures(s,owner,[example,example]));
    let page=await read();expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({text:example.text,visibility:'private',pinned:false});
    await use(s=>ingestCaptures(s,owner,[{...example,triggerMessageId:'reply-b',tags:['research'],pinned:true}]));
    page=await read();expect(page.items[0].tags).toEqual(['longevity','research']);expect(page.items[0].pinned).toBe(true);
    const shared=await use(s=>s.run('MATCH (n) WHERE (n:Message OR n:Thought) AND (n.ownerId=$owner OR n.userId=$owner) RETURN count(n) AS count',{owner}));expect(shared.records[0].get('count').toNumber()).toBe(0);
  });
  it('keeps pin and tag edits through replay, and denies other owners',async()=>{
    const id=(await read()).items[0].id;
    await use(s=>updateCapture(s,owner,id,{pinned:false,tags:['edited']}));
    await use(s=>ingestCaptures(s,owner,[{...example,triggerMessageId:'reply-b',tags:['research'],pinned:true}]));
    expect((await read()).items[0]).toMatchObject({pinned:false,tags:['edited']});
    expect((await use(s=>listCaptures(s,other))).items).toEqual([]);
    await expect(use(s=>updateCapture(s,other,id,{pinned:true}))).rejects.toMatchObject({status:404});
    await expect(use(s=>forgetCapture(s,other,id))).rejects.toMatchObject({status:404});
  });
  it('adds direct notes and structured details to the same private stream, independent of pinning',async()=>{
    const threadId=captureKeys(owner,parseCapture(example)).threadId;
    await use(s=>addCapture(s,owner,{text:'42 Example Lane',threadId,destination:'contact',contactLabel:'Mailing address',pinned:false}));
    await use(s=>addCapture(s,owner,{text:'Written directly',threadId,tags:['longevity'],pinned:true}));
    const details=await use(s=>listCaptures(s,owner,{threadId,destination:'contact'}));
    expect(details.items).toHaveLength(1);expect(details.items[0]).toMatchObject({contactLabel:'Mailing address',text:'42 Example Lane',pinned:false});
    expect((await read()).items[0].text).toBe('Written directly');
    await expect(use(s=>addCapture(s,other,{text:'Cannot write into this person',threadId}))).rejects.toMatchObject({status:404});
  });
  it('paginates pinned first, binds cursors to the owner and selected view',async()=>{
    const page=await use(s=>listCaptures(s,owner,{limit:1}));expect(page.nextCursor).toBeTruthy();
    const next=await use(s=>listCaptures(s,owner,{limit:1,cursor:page.nextCursor}));expect(next.items[0].id).not.toBe(page.items[0].id);
    await expect(use(s=>listCaptures(s,other,{cursor:page.nextCursor}))).rejects.toMatchObject({status:400});
    await expect(use(s=>listCaptures(s,owner,{cursor:page.nextCursor,destination:'contact'}))).rejects.toMatchObject({status:400});
    expect((await use(s=>listCaptureThreads(s,owner))).length).toBe(1);
  });
  it('forgets payload while retaining a tombstone that blocks reimport',async()=>{
    const id=captureKeys(owner,parseCapture(example)).id;
    await use(s=>forgetCapture(s,owner,id));await use(s=>ingestCaptures(s,owner,[example]));
    expect((await read()).items.some(x=>x.id===id)).toBe(false);
    const r=await use(s=>s.run('MATCH (c:OpenChatCapture {id:$id}) RETURN c',{id}));expect(r.records[0].get('c').properties.text).toBeUndefined();
  });
  it('scopes device credentials, stores only a digest, and honors revocation',async()=>{
    const d=await use(s=>createCaptureDevice(s,owner,'Test Mac'));expect(await use(s=>authenticateCaptureDevice(s,d.token))).toBe(owner);
    const r=await use(s=>s.run('MATCH (d:OpenChatCaptureDevice {id:$id}) RETURN d',{id:d.id}));expect(JSON.stringify(r.records[0].get('d').properties)).not.toContain(d.token);
    await use(s=>s.run('MATCH (d:OpenChatCaptureDevice {id:$id}) SET d.revokedAt=$now',{id:d.id,now:new Date().toISOString()}));
    await expect(use(s=>authenticateCaptureDevice(s,d.token))).rejects.toMatchObject({status:401});
  });
});
