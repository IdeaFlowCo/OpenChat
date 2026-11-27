import express from 'express';
import jwt from 'jsonwebtoken';
import {createHash,randomBytes} from 'node:crypto';
import neo4j,{type Driver} from 'neo4j-driver';
import request from 'supertest';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const {NEO4J_TEST_URI:uri,NEO4J_TEST_USER:user,NEO4J_TEST_PASSWORD:password}=process.env;
const integration=uri&&user&&password?describe.sequential:describe.skip;
integration('Beeper relay is a private transactional importer, not machine authority',{timeout:30000},()=>{
  const fixture=`beeper-${Date.now()}-${Math.random().toString(36).slice(2)}`,uid=fixture+'-owner',other=fixture+'-other';
  const connectionId=createHash('sha256').update(fixture).digest('hex').slice(0,48),accountKey='1'.repeat(64),chatKey='2'.repeat(64);
  const secret='ocbr_'+randomBytes(32).toString('base64url'),relayTokenHash=createHash('sha256').update(secret).digest('hex');
  const offer={protocol:'openchat.beeper.read.v1',destination:'https://chat.ideaflow.app',connectionId,accountKey,machineKey:'3'.repeat(64),deviceKey:'4'.repeat(64),catalogueGrantId:'5'.repeat(48),relayTokenHash,ownerUserId:uid,relayBinding:'',expiresAt:new Date(Date.now()+86400000).toISOString()};
  const app=express();let driver:Driver,db:typeof import('../src/db.js'),service:typeof import('../src/services/beeperRelay.js');
  let job:{id:string;epoch:number},lease:{leaseId:string},chatId:string;
  const auth=(id=uid,extra:Record<string,unknown>={})=>'Bearer '+jwt.sign({userId:id,email:'synthetic@example.test',...extra},process.env.JWT_SECRET||'dev-secret-change-me');
  const run=async(q:string,p:Record<string,unknown>={})=>{const s=driver.session();try{return await s.run(q,p);}finally{await s.close();}};
  const ownerPost=(path:string,body:unknown)=>request(app).post(path).set('Authorization',auth()).send(body);
  const relayPost=(path:string,body:unknown)=>request(app).post('/api/beeper/relay/'+path).set('Authorization','Bearer '+secret).send(body);
  const path='/api/beeper/connections/'+connectionId;
  const payload=(text='Synthetic source text',asOf='2026-11-26T23:00:00Z')=>({schemaVersion:1,
    source:{network:'whatsapp',accountKey,chatKey,chatType:'group',title:'Synthetic source'},
    coverage:{asOf,method:'synthetic-api',complete:false},
    participants:[{sourceKey:'synthetic-sender',displayName:'Synthetic Sender',nameSource:'unknown'}],
    messages:[{sourceMessageId:'synthetic-message',senderKey:'synthetic-sender',sentAt:'2026-11-26T21:00:00Z',kind:'text',text}],asks:[]});
  const batch=(value:unknown,sequence=0,final=false)=>({jobId:job.id,leaseId:lease.leaseId,sequence,final,payload:value,digest:service.beeperPayloadDigest({payload:value,final})});
  const reserve=async(requestId:string)=>{
    const response=await ownerPost(path+'/reads',{chatKey,clientRequestId:requestId,kind:'refresh'});expect(response.status).toBe(201);job=response.body;
    expect(typeof job.epoch).toBe('number');
    const attached=await request(app).put(path+'/reads/'+job.id+'/intent').set('Authorization',auth()).send({frame:Buffer.alloc(48,7).toString('base64')});expect(attached.status).toBe(200);
    const claimed=await relayPost('claim',{});expect(claimed.status).toBe(200);expect(claimed.body.job.id).toBe(job.id);lease=claimed.body.job;
  };
  beforeAll(async()=>{
    process.env.NEO4J_URI=uri!;process.env.NEO4J_USER=user!;process.env.NEO4J_PASSWORD=password!;
    db=await import('../src/db.js');service=await import('../src/services/beeperRelay.js');
    offer.relayBinding=service.beeperRelayBinding(secret,offer as any);
    driver=neo4j.driver(uri!,neo4j.auth.basic(user!,password!));const s=driver.session();
    try{await service.ensureBeeperReadSchema(s);await(await import('../src/services/importedChats.js')).ensureImportedChatSchema(s);}finally{await s.close();}
    const {exceptImportBody}=await import('../src/routes/importedChats.js');app.use(exceptImportBody(express.json()));
    const routes=await import('../src/routes/beeper.js');app.use('/api/beeper/relay',routes.beeperRelayRoutes);app.use('/api/beeper',routes.beeperOwnerRoutes);
    await run(`CREATE(:User {id:$uid,fixture:$fixture}),(:User {id:$other,fixture:$fixture})`,{uid,other,fixture});
  },40000);
  afterAll(async()=>{if(driver){await run(`MATCH(n) WHERE n.ownerUserId IN $owners OR n.fixture=$fixture DETACH DELETE n`,{owners:[uid,other],fixture});await driver.close();await db.closeDatabase();}},40000);
  it('requires direct owner approval; Mac public offer contains no secret and gains no machine operation from the server',async()=>{
    expect((await request(app).post('/api/beeper/connections').send({offer})).status).toBe(401);
    expect((await request(app).post('/api/beeper/connections').set('Authorization',auth(uid,{embedded:'unlinked'})).send({offer})).status).toBe(403);
    const approved=await ownerPost('/api/beeper/connections',{offer});expect(approved.status).toBe(201);expect(approved.body.id).toBe(connectionId);
    expect(JSON.stringify(approved.body)).not.toContain(secret);expect(JSON.stringify(approved.body)).not.toContain(relayTokenHash);
    expect((await request(app).get(path+'/chats').set('Authorization',auth(other))).status).toBe(404);
    expect((await request(app).post('/api/beeper/relay/claim').set('Authorization',auth()).send({})).status).toBe(401);
    expect((await request(app).get('/api/beeper/connections').set('Authorization','Bearer '+secret)).status).toBe(401);
  });
  it('binds the importer credential to the locally approved recipient even if an edited public offer registers first',async()=>{
    expect((await request(app).post('/api/beeper/connections').set('Authorization',auth(other)).send({offer})).status).toBe(403);
    const route='9'.repeat(48),localToken='ocbr_'+randomBytes(32).toString('base64url');
    const original={...offer,connectionId:route,relayTokenHash:createHash('sha256').update(localToken).digest('hex')};original.relayBinding=service.beeperRelayBinding(localToken,original as any);
    const edited={...original,ownerUserId:other};expect((await request(app).post('/api/beeper/connections').set('Authorization',auth(other)).send({offer:edited})).status).toBe(201);
    const publish=await request(app).post('/api/beeper/relay/catalogue').set('Authorization','Bearer '+localToken).send({items:[{accountKey,chatKey,network:'whatsapp',chatType:'group',title:'Must not disclose',capturedAt:new Date().toISOString(),lastActivityAt:null}],complete:false});
    expect(publish.status).toBe(403);expect(publish.body.error).toBe('relay_owner_binding_mismatch');
    expect(Number((await run(`MATCH(e:OpenChatBeeperCatalogue {connectionId:$route}) RETURN count(e) AS n`,{route})).records[0]!.get('n'))).toBe(0);
  });
  it('authenticates before a large upload and persists only the permitted catalogue fields',async()=>{
    const anonymous=await request(app).post('/api/beeper/relay/deliver').set('Content-Type','application/json').send('x'.repeat(150000));expect(anonymous.status).toBe(401);
    const entry={accountKey,chatKey,network:'whatsapp',chatType:'group',title:'Synthetic source',capturedAt:new Date().toISOString(),lastActivityAt:null,
      preview:'private preview canary',participants:['private roster canary'],srcURL:'https://never-fetch.invalid'};
    expect((await relayPost('catalogue',{items:[{...entry,accountKey:'f'.repeat(64)}],complete:false})).status).toBe(403);
    expect((await relayPost('catalogue',{items:[entry],complete:true})).status).toBe(200);
    const rows=await run(`MATCH(e:OpenChatBeeperCatalogue {ownerUserId:$uid}) RETURN properties(e) AS props`,{uid});
    const serialized=JSON.stringify(rows.records[0]!.get('props'));expect(serialized).not.toContain('canary');expect(serialized).not.toContain('srcURL');
    expect((await request(app).get(path+'/chats').set('Authorization',auth())).body.items[0].title).toBe('Synthetic source');
  });
  it('pages a bounded searchable owner catalogue and resolves a selected key outside the first page',async()=>{
    const entries=Array.from({length:201},(_,index)=>({accountKey,chatKey:(index+100).toString(16).padStart(64,'0'),network:'whatsapp',chatType:'group',title:'Synthetic page '+index,capturedAt:new Date().toISOString(),lastActivityAt:null}));
    expect((await relayPost('catalogue',{items:entries.slice(0,200),complete:false})).status).toBe(200);
    expect((await relayPost('catalogue',{items:entries.slice(200),complete:true})).status).toBe(200);
    const first=await request(app).get(path+'/chats').set('Authorization',auth());expect(first.body.items).toHaveLength(200);expect(first.body.nextCursor).toBeTypeOf('string');
    const next=await request(app).get(path+'/chats').query({cursor:first.body.nextCursor}).set('Authorization',auth());expect(next.body.items).toHaveLength(2);expect(next.body.nextCursor).toBeNull();
    const selected=entries[200]!.chatKey;
    expect((await request(app).get(path+'/chats').query({chatKey:selected}).set('Authorization',auth())).body.items.map((e:{chatKey:string})=>e.chatKey)).toEqual([selected]);
    expect((await request(app).get(path+'/chats').query({search:'page 200'}).set('Authorization',auth())).body.items).toHaveLength(1);
    expect((await request(app).get(path+'/chats').query({chatKey:'bad-key'}).set('Authorization',auth())).status).toBe(400);
    expect((await request(app).get(path+'/chats').query({chatKey:selected}).set('Authorization',auth(other))).status).toBe(404);
    expect((await ownerPost('/api/beeper/connections',{offer:{...offer,catalogueGrantId:'6'.repeat(48)}})).status).toBe(409);
  });
  it('queues no source read before a device intent and coalesces owner retries without expanding chat scope',async()=>{
    const initial=await ownerPost(path+'/reads',{chatKey,clientRequestId:'first',kind:'open'});expect(initial.status).toBe(201);job=initial.body;
    const retry=await ownerPost(path+'/reads',{chatKey,clientRequestId:'first',kind:'open'});expect(retry.body.id).toBe(job.id);
    expect((await relayPost('claim',{})).body.job).toBeNull();
    expect((await request(app).put(path+'/reads/'+job.id+'/intent').set('Authorization',auth(other)).send({frame:Buffer.alloc(48,7).toString('base64')})).status).toBe(404);
    expect((await request(app).put(path+'/reads/'+job.id+'/intent').set('Authorization',auth()).send({frame:Buffer.alloc(48,7).toString('base64')})).status).toBe(200);
    const claimed=await relayPost('claim',{});lease=claimed.body.job;expect(claimed.body.job.chatKey).toBe(chatKey);expect(typeof claimed.body.job.epoch).toBe('number');
  });
  it('commits import and acknowledgement exactly once, refuses changed retries, and marks success only at final batch',async()=>{
    const value=payload();const first=await relayPost('deliver',batch(value));expect(first.status).toBe(200);chatId=first.body.chatId;
    expect((await relayPost('deliver',batch(value))).body.duplicate).toBe(true);
    expect((await relayPost('deliver',batch(payload('Changed same sequence')))).status).toBe(409);
    let record=await run(`MATCH(c:OpenChatBeeperConnection {id:$id}) RETURN c.lastSuccessAt AS success`,{id:connectionId});expect(record.records[0]!.get('success')).toBeNull();
    const changed=payload('Synthetic edited source','2026-11-26T22:59:00Z');changed.messages[0]!.editedAt='2026-11-26T23:01:00Z';
    expect((await relayPost('deliver',batch(changed,1,true))).status).toBe(200);
    record=await run(`MATCH(c:OpenChatBeeperConnection {id:$id}) RETURN c.lastSuccessAt AS success`,{id:connectionId});expect(record.records[0]!.get('success')).toBeTypeOf('string');
    const rows=await run(`MATCH(m:OpenChatImportedMessage {ownerUserId:$uid,chatId:$chatId}) RETURN m.text AS text`,{uid,chatId});expect(rows.records).toHaveLength(1);expect(rows.records[0]!.get('text')).toBe('Synthetic edited source');
    const normal=await import('../src/services/importedChats.js');await expect(normal.importChat(uid,value,{importedBy:'owner'})).rejects.toMatchObject({status:409});
  });
  it('resumes the exact completed job to replay a lost final ACK and refuses old epochs',async()=>{
    expect((await relayPost('claim',{})).body.job).toBeNull();
    const resumed=await relayPost('resume',{jobId:job.id});expect(resumed.status).toBe(200);expect(resumed.body.job.id).toBe(job.id);
    expect(resumed.body.job.nextSequence).toBe(2);expect(resumed.body.job).not.toHaveProperty('connectionId');
    const changed=payload('Synthetic edited source','2026-11-26T22:59:00Z');changed.messages[0]!.editedAt='2026-11-26T23:01:00Z';
    expect((await relayPost('deliver',batch(changed,1,true))).body.duplicate).toBe(true);
    const old=job.id;await reserve('resume-superseding');expect((await relayPost('resume',{jobId:old})).status).toBe(409);
    await run(`MATCH(j:OpenChatBeeperJob {id:$id}) SET j.leaseUntil='2000-01-01T00:00:00.000Z'`,{id:job.id});
    const prior=lease.leaseId,renewed=await relayPost('resume',{jobId:job.id});expect(renewed.status).toBe(200);expect(renewed.body.job.id).toBe(job.id);expect(renewed.body.job.leaseId).not.toBe(prior);lease=renewed.body.job;
    expect((await relayPost('fail',{jobId:job.id,leaseId:lease.leaseId,code:'source_unavailable'})).status).toBe(200);
    expect((await relayPost('resume',{jobId:job.id})).status).toBe(409);
  });
  it('rolls back every import change and receipt when immutable source attribution conflicts',async()=>{
    await reserve('second');const invalid=payload('Must not overwrite');invalid.participants.push({sourceKey:'different-sender',displayName:'Other',nameSource:'unknown'});
    invalid.messages[0]!.senderKey='different-sender';invalid.messages.push({...invalid.messages[0]!,sourceMessageId:'must-not-commit'});
    expect((await relayPost('deliver',batch(invalid,0,true))).status).toBe(409);
    expect(Number((await run(`MATCH(m:OpenChatImportedMessage {ownerUserId:$uid,sourceMessageId:'must-not-commit'}) RETURN count(m) AS n`,{uid})).records[0]!.get('n'))).toBe(0);
    const status=await request(app).get(path+'/reads/'+job.id).set('Authorization',auth());expect(status.body.nextSequence).toBe(0);expect(status.body.state).toBe('leased');
    expect((await relayPost('deliver',batch(payload('Fresh epoch after conflict','2026-11-26T22:58:00Z'),0,true))).status).toBe(200);
  });
  it('records only a stable source error and permits a new epoch after a failed scan',async()=>{
    await reserve('failure');
    expect((await relayPost('fail',{jobId:job.id,leaseId:lease.leaseId,code:'private error text'})).status).toBe(400);
    expect((await relayPost('fail',{jobId:job.id,leaseId:lease.leaseId,code:'source_unavailable'})).status).toBe(200);
    const failure=await request(app).get(path+'/reads/'+job.id).set('Authorization',auth());expect(failure.body).toMatchObject({state:'failed',lastError:'source_unavailable'});
    const old=job;await reserve('after-failure');expect(job.epoch).toBeGreaterThan(old.epoch);
    expect((await relayPost('deliver',batch(payload('Recovered source'),0,true))).status).toBe(200);
  });
  it('fences expired leases and revoked grants before any late upload, and exports no verifier or ciphertext',async()=>{
    await reserve('third');await run(`MATCH(j:OpenChatBeeperJob {id:$id}) SET j.leaseUntil='2000-01-01T00:00:00.000Z'`,{id:job.id});
    expect((await relayPost('deliver',batch(payload('Expired lease')))).status).toBe(409);
    const s=driver.session();try{const exported=await s.executeRead(tx=>service.exportBeeperReadTransport(tx,uid));const text=JSON.stringify(exported);expect(text).not.toContain(secret);expect(text).not.toContain(relayTokenHash);expect(text).not.toContain('intent');}finally{await s.close();}
    expect((await request(app).delete(path).set('Authorization',auth())).status).toBe(200);
    expect((await relayPost('deliver',batch(payload('Revoked upload')))).status).toBe(401);
    const rows=await run(`MATCH(m:OpenChatImportedMessage {ownerUserId:$uid}) RETURN collect(m.text) AS texts`,{uid});expect(rows.records[0]!.get('texts')).not.toContain('Revoked upload');
  });
  it('keeps optional iMessage catalogue and history in the same private transactional reader',async()=>{
    const route='a'.repeat(48),localToken='ocbr_'+randomBytes(32).toString('base64url'),selected='b'.repeat(64);
    const localOffer={...offer,connectionId:route,relayTokenHash:createHash('sha256').update(localToken).digest('hex')};
    localOffer.relayBinding=service.beeperRelayBinding(localToken,localOffer as any);
    expect((await ownerPost('/api/beeper/connections',{offer:localOffer})).status).toBe(201);
    const relay=(action:string,body:unknown)=>request(app).post('/api/beeper/relay/'+action).set('Authorization','Bearer '+localToken).send(body);
    const entry={accountKey,chatKey:selected,network:'imessage',chatType:'direct',title:'Synthetic iMessage',capturedAt:new Date().toISOString(),lastActivityAt:null};
    expect((await relay('catalogue',{items:[entry],complete:false})).status).toBe(200);
    const p='/api/beeper/connections/'+route;
    expect((await request(app).get(p+'/chats').set('Authorization',auth())).body.items[0]).toMatchObject({network:'imessage',chatKey:selected});
    expect((await request(app).get(p+'/chats').set('Authorization',auth(other))).status).toBe(404);
    const read=await ownerPost(p+'/reads',{chatKey:selected,clientRequestId:'imessage',kind:'open'});expect(read.status).toBe(201);
    expect((await request(app).put(p+'/reads/'+read.body.id+'/intent').set('Authorization',auth()).send({frame:Buffer.alloc(48,7).toString('base64')})).status).toBe(200);
    const claimed=await relay('claim',{});expect(claimed.body.job.id).toBe(read.body.id);
    const value=payload();value.source={...value.source,network:'imessage',chatKey:selected,chatType:'direct'};
    const body={jobId:read.body.id,leaseId:claimed.body.job.leaseId,sequence:0,final:true,payload:value,digest:service.beeperPayloadDigest({payload:value,final:true})};
    const imported=await relay('deliver',body);expect(imported.status).toBe(200);
    expect((await relay('deliver',body)).body.duplicate).toBe(true);
    const rows=await run('MATCH(c:OpenChatImportedChat {ownerUserId:$uid,id:$id}) RETURN c.network AS network',{uid,id:imported.body.chatId});
    expect(rows.records[0]!.get('network')).toBe('imessage');
    expect((await request(app).delete(p).set('Authorization',auth())).status).toBe(200);
    expect((await relay('deliver',body)).status).toBe(401);
  });
  it('account deletion removes all new transport records in the owner fence and never affects another owner',async()=>{
    const imported=await import('../src/services/importedChatAccount.js');const s=driver.session();
    try{await s.executeWrite(async tx=>{await imported.deleteImportedChatsForUser(tx,uid);await service.deleteBeeperReadTransport(tx,uid);await tx.run(`MATCH(u:User {id:$uid}) DETACH DELETE u`,{uid});});}finally{await s.close();}
    expect(Number((await run(`MATCH(n) WHERE n.ownerUserId=$uid RETURN count(n) AS n`,{uid})).records[0]!.get('n'))).toBe(0);
    expect(Number((await run(`MATCH(u:User {id:$other}) RETURN count(u) AS n`,{other})).records[0]!.get('n'))).toBe(1);
    expect((await ownerPost('/api/beeper/connections',{offer:{...offer,connectionId:'e'.repeat(48)}})).status).toBe(404);
  });
});
