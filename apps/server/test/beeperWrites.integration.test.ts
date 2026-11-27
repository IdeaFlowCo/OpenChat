import express from 'express';import jwt from 'jsonwebtoken';import request from 'supertest';import neo4j,{type Driver}from'neo4j-driver';import{createHash,randomBytes}from'node:crypto';import{afterAll,beforeAll,describe,expect,it}from'vitest';
const {NEO4J_TEST_URI:uri,NEO4J_TEST_USER:user,NEO4J_TEST_PASSWORD:password}=process.env,runSuite=uri&&user&&password?describe.sequential:describe.skip;
runSuite('Beeper write relay transports opaque typed requests, never machine authority',{timeout:30000},()=>{
 const owner='beeper-send-'+randomBytes(12).toString('hex'),other=owner+'-other',id=randomBytes(24).toString('hex'),token='ocbs_'+randomBytes(32).toString('base64url'),hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const offer={protocol:'openchat.beeper.send.v1',connectionId:id,ownerUserId:owner,machineKey:'1'.repeat(64),deviceKey:'2'.repeat(64),accountKey:'3'.repeat(64),chatKey:'4'.repeat(64),writeGrantId:'5'.repeat(48),expiresAt:new Date(Date.now()+3600000).toISOString(),destination:'https://chat.ideaflow.app',relayTokenHash:hash(token),relayBinding:''};
 const app=express(),prefix='/api/beeper/write-connections/'+id,operationId=randomBytes(24).toString('hex'),opaqueIntent=Buffer.alloc(128,3).toString('base64');let driver:Driver,db:typeof import('../src/db.js'),service:typeof import('../src/services/beeperWrites.js'),lease:string;
 const auth=(uid=owner,extra:Record<string,unknown>={})=>'Bearer '+jwt.sign({userId:uid,email:'synthetic@example.test',...extra},process.env.JWT_SECRET||'dev-secret-change-me');
 const run=async(q:string,p:Record<string,unknown>={})=>{const s=driver.session();try{return await s.run(q,p);}finally{await s.close();}};
 const relay=(path:string,body:unknown)=>request(app).post('/api/beeper/write-relay/'+path).set('Authorization','Bearer '+token).send(body);
 beforeAll(async()=>{process.env.NEO4J_URI=uri!;process.env.NEO4J_USER=user!;process.env.NEO4J_PASSWORD=password!;db=await import('../src/db.js');service=await import('../src/services/beeperWrites.js');driver=neo4j.driver(uri!,neo4j.auth.basic(user!,password!));const s=driver.session();try{await service.ensureBeeperWriteSchema(s);}finally{await s.close();}offer.relayBinding=service.writeRelayBinding(token,offer as any);const {exceptImportBody}=await import('../src/routes/importedChats.js'),routes=await import('../src/routes/beeperWrites.js'),reads=await import('../src/routes/beeper.js');app.use(exceptImportBody(express.json()));app.use('/api/beeper/write-relay',routes.beeperWriteRelayRoutes);app.use('/api/beeper/relay',reads.beeperRelayRoutes);app.use('/api/beeper',routes.beeperWriteOwnerRoutes);app.use('/api/beeper',reads.beeperOwnerRoutes);await run('CREATE(:User {id:$owner}),(:User {id:$other})',{owner,other});},40000);
 afterAll(async()=>{if(driver){await run('MATCH(n) WHERE n.ownerUserId IN $owners OR (n:User AND n.id IN $owners) DETACH DELETE n',{owners:[owner,other]});await driver.close();await db.closeDatabase();}},40000);
 it('requires a direct owner and separate write offer/token; never expands a read credential',async()=>{
  expect((await request(app).post('/api/beeper/write-connections').send({offer})).status).toBe(401);
  expect((await request(app).post('/api/beeper/write-connections').set('Authorization',auth(owner,{embedded:'unlinked'})).send({offer})).status).toBe(403);
  expect((await request(app).post('/api/beeper/write-connections').set('Authorization',auth(other)).send({offer})).status).toBe(403);
  const r=await request(app).post('/api/beeper/write-connections').set('Authorization',auth()).send({offer});expect(r.status).toBe(201);
  const rows=await request(app).get('/api/beeper/write-connections').set('Authorization',auth());expect(rows.status).toBe(200);expect(JSON.stringify(rows.body)).not.toContain(token);expect(JSON.stringify(rows.body)).not.toContain(offer.relayTokenHash);
  expect((await request(app).post('/api/beeper/write-relay/claim').set('Authorization','Bearer ocbr_'+randomBytes(32).toString('base64url')).send({})).status).toBe(401);
  expect((await request(app).post('/api/beeper/relay/claim').set('Authorization','Bearer '+token).send({})).status).toBe(401);
 });
 it('refuses an edited copied public recipient at every token operation',async()=>{
  const local='ocbs_'+randomBytes(32).toString('base64url'),original={...offer,connectionId:randomBytes(24).toString('hex'),relayTokenHash:hash(local)};original.relayBinding=service.writeRelayBinding(local,original as any);const edited={...original,ownerUserId:other};
  expect((await request(app).post('/api/beeper/write-connections').set('Authorization',auth(other)).send({offer:edited})).status).toBe(201);
  const r=await request(app).post('/api/beeper/write-relay/claim').set('Authorization','Bearer '+local).send({});expect(r.status).toBe(403);expect(r.body.error).toBe('write_recipient_binding_mismatch');
 });
 it('authenticates before the larger sealed body, queues ciphertext only and coalesces the exact operation',async()=>{
  const large=Buffer.alloc(100000,7).toString('base64');
  expect((await request(app).post(prefix+'/sends').set('Content-Type','application/json').send(JSON.stringify({operationId,opaqueIntent:large}))).status).toBe(401);
  expect((await request(app).post(prefix+'/sends').set('Authorization',auth()).send({operationId,opaqueIntent,text:'must not accept plaintext'})).status).toBe(400);
  const r=await request(app).post(prefix+'/sends').set('Authorization',auth()).send({operationId,opaqueIntent});expect(r.status).toBe(201);expect(r.body).toMatchObject({operationId,transportState:'queued',receipt:null});
  expect((await request(app).post(prefix+'/sends').set('Authorization',auth()).send({operationId,opaqueIntent})).body.operationId).toBe(operationId);
  expect((await request(app).post(prefix+'/sends').set('Authorization',auth()).send({operationId,opaqueIntent:Buffer.alloc(128,4).toString('base64')})).status).toBe(409);
  expect((await request(app).post(prefix+'/sends').set('Authorization',auth()).send({operationId:randomBytes(24).toString('hex'),opaqueIntent})).status).toBe(409);
  expect((await request(app).get(prefix+'/sends/'+operationId).set('Authorization',auth(other))).status).toBe(404);
 });
 it('does not mutate another owner operation while refusing a chosen-ID collision',async()=>{
  const route=randomBytes(24).toString('hex'),secret='ocbs_'+randomBytes(32).toString('base64url'),alternate={...offer,ownerUserId:other,connectionId:route,relayTokenHash:hash(secret)};alternate.relayBinding=service.writeRelayBinding(secret,alternate as any);
  expect((await request(app).post('/api/beeper/write-connections').set('Authorization',auth(other)).send({offer:alternate})).status).toBe(201);
  const before=(await run('MATCH(j:OpenChatBeeperSend {id:$op}) RETURN properties(j) AS j',{op:operationId})).records[0]!.get('j');
  expect((await request(app).post('/api/beeper/write-connections/'+route+'/sends').set('Authorization',auth(other)).send({operationId,opaqueIntent})).status).toBe(409);
  const after=(await run('MATCH(j:OpenChatBeeperSend {id:$op}) RETURN properties(j) AS j',{op:operationId})).records[0]!.get('j');expect(after).toEqual(before);
 });
 it('leases only the approved connection and stores opaque monotonic receipts without calling them confirmed',async()=>{
  const r=await relay('claim',{});expect(r.status).toBe(200);expect(r.body.job).toMatchObject({id:operationId,intent:opaqueIntent});lease=r.body.job.leaseId;
  expect((await relay('claim',{})).body.job).toBeNull();
  const wire=Buffer.alloc(128,9).toString('base64'),body={operationId,leaseId:lease,wire,revision:1,terminal:false};
  expect((await relay('receipt',body)).status).toBe(200);expect((await relay('receipt',body)).body.duplicate).toBe(true);
  expect((await relay('receipt',{...body,wire:Buffer.alloc(128,8).toString('base64')})).status).toBe(409);
  const s=await request(app).get(prefix+'/sends/'+operationId).set('Authorization',auth());expect(s.body).toMatchObject({transportState:'waiting',receipt:wire,receiptRevision:1});expect(s.body).not.toHaveProperty('confirmed');
  const resumed=await relay('claim',{operationId});expect(resumed.body.job.id).toBe(operationId);lease=resumed.body.job.leaseId;
  expect((await relay('receipt',{operationId,leaseId:lease,wire:Buffer.alloc(128,10).toString('base64'),revision:2,terminal:true})).status).toBe(200);
  expect((await request(app).get(prefix+'/sends/'+operationId).set('Authorization',auth())).body.transportState).toBe('done');
  await run(`MATCH(j:OpenChatBeeperSend {id:$op}) SET j.leaseUntil='2000-01-01T00:00:00.000Z'`,{op:operationId});expect((await relay('claim',{})).body.job).toBeNull();
 });
 it('serializes revocation against a concurrent receipt and rejects every later upload',async()=>{
  for(let n=0;n<3;n++){
   const route=randomBytes(24).toString('hex'),secret='ocbs_'+randomBytes(32).toString('base64url'),fresh={...offer,connectionId:route,relayTokenHash:hash(secret)};fresh.relayBinding=service.writeRelayBinding(secret,fresh as any);
   expect((await request(app).post('/api/beeper/write-connections').set('Authorization',auth()).send({offer:fresh})).status).toBe(201);
   const op=randomBytes(24).toString('hex');expect((await request(app).post('/api/beeper/write-connections/'+route+'/sends').set('Authorization',auth()).send({operationId:op,opaqueIntent})).status).toBe(201);
   const claim=await request(app).post('/api/beeper/write-relay/claim').set('Authorization','Bearer '+secret).send({});const body={operationId:op,leaseId:claim.body.job.leaseId,wire:Buffer.alloc(128,9).toString('base64'),revision:1,terminal:false};
   const [revoked,receipt]=await Promise.all([request(app).delete('/api/beeper/write-connections/'+route).set('Authorization',auth()),request(app).post('/api/beeper/write-relay/receipt').set('Authorization','Bearer '+secret).send(body)]);expect(revoked.status).toBe(200);expect([200,401,403]).toContain(receipt.status);
   expect((await request(app).post('/api/beeper/write-relay/receipt').set('Authorization','Bearer '+secret).send(body)).status).toBe(401);
   expect((await request(app).get('/api/beeper/write-connections/'+route+'/sends/'+op).set('Authorization',auth())).body.transportState).toBe('cancelled');
  }
 });
 it('exports no ciphertext/token verifier and fences revoked/deleted accounts under owner locks',async()=>{
  const s=driver.session();try{const value=JSON.stringify(await s.executeRead(t=>service.exportBeeperWrites(t,owner)));expect(value).not.toContain('intent');expect(value).not.toContain('relayToken');expect(value).not.toContain(token);}finally{await s.close();}
  expect((await request(app).delete(prefix).set('Authorization',auth())).status).toBe(200);expect((await relay('claim',{operationId})).status).toBe(401);
  expect((await request(app).post(prefix+'/sends').set('Authorization',auth()).send({operationId:randomBytes(24).toString('hex'),opaqueIntent})).status).toBe(403);
  const session=driver.session();try{await session.executeWrite(async t=>{await t.run('MATCH(u:User {id:$owner}) SET u.beeperWriteRevision=coalesce(u.beeperWriteRevision,0)+1',{owner});await service.deleteBeeperWrites(t,owner);await t.run('MATCH(u:User {id:$owner}) DETACH DELETE u',{owner});});}finally{await session.close();}
  expect((await request(app).post('/api/beeper/write-connections').set('Authorization',auth()).send({offer:{...offer,connectionId:randomBytes(24).toString('hex')}})).status).toBe(404);
  expect(Number((await run('MATCH(n) WHERE n.ownerUserId=$owner RETURN count(n) AS n',{owner})).records[0]!.get('n'))).toBe(0);
 });
});
