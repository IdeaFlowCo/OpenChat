import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j,{type Driver} from 'neo4j-driver';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import type {Server} from 'node:http';
import nacl from 'tweetnacl';
import {BeeperReadAuthority} from '../../../scripts/beeper-client/readAuthority.mjs';
import {BeeperForegroundJournal,createBeeperForegroundRunner} from '../../../scripts/beeper-client/foregroundRunner.mjs';
import {createBeeperReadonlyClient} from '../../../scripts/beeper-client/desktopApi.mjs';
import {createBeeperRelayTransport} from '../../../scripts/beeper-client/relayTransport.mjs';
import {acceptBeeperReadOffer,enableBeeperReadRegistry} from '../../mobile/src/services/beeper/deviceRegistry';
import {authorizeBeeperRead} from '../../mobile/src/services/beeper/readIntent';
const local=vi.hoisted(()=>({owner:'',storage:new Map<string,string>()}));
vi.mock('../../mobile/src/api/client',()=>({getUser:async()=>({userId:local.owner})}));
vi.mock('expo-crypto',()=>({getRandomValues:(b:Uint8Array)=>crypto.getRandomValues(b),getRandomBytesAsync:async(n:number)=>new Uint8Array(randomBytes(n)),CryptoDigestAlgorithm:{SHA256:'SHA-256'},digestStringAsync:async(_:unknown,s:string)=>createHash('sha256').update(s).digest('hex')}));
vi.mock('expo-secure-store',()=>({WHEN_UNLOCKED_THIS_DEVICE_ONLY:6,isAvailableAsync:async()=>true,getItemAsync:async(k:string)=>local.storage.get(k)??null,setItemAsync:async(k:string,v:string)=>{if(v.length>2048)throw Error('secure item too large');local.storage.set(k,v);}}));
const enabled=!!(process.env.NEO4J_TEST_URI&&process.env.NEO4J_TEST_USER&&process.env.NEO4J_TEST_PASSWORD);
let driver:Driver|undefined,db:typeof import('../src/db.js')|undefined;
beforeAll(async()=>{if(!enabled)return;process.env.NEO4J_URI=process.env.NEO4J_TEST_URI;process.env.NEO4J_USER=process.env.NEO4J_TEST_USER;process.env.NEO4J_PASSWORD=process.env.NEO4J_TEST_PASSWORD;db=await import('../src/db.js');driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER!,process.env.NEO4J_TEST_PASSWORD!));});
afterAll(async()=>{await driver?.close();await db?.closeDatabase();});
async function listen(app:express.Express){
 for(let attempt=0;attempt<40;attempt++){const port=7000+Math.floor(Math.random()*3000);try{const server=await new Promise<Server>((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.once('error',reject);});return {server,port};}catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;}}
 throw Error('No task-owned loopback port');
}
const close=(s:Server)=>new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()));
it.skipIf(!enabled)('runs native sealed intent through real HTTP, local SQLite, GET adapter and atomic graph import; lost final ACK recovers without another source GET',{timeout:60000},async()=>{
 const owner='beeper-flow-'+randomBytes(12).toString('hex');local.owner=owner;
 const dir=mkdtempSync(join(tmpdir(),'beeper-flow-')),paired=join(dir,'paired'),state=join(dir,'state');mkdirSync(paired,{mode:0o700});
 const pairRoute=randomBytes(24).toString('hex'),key=()=>{const k=nacl.box.keyPair();return {publicKey:Buffer.from(k.publicKey).toString('hex'),secretKey:Buffer.from(k.secretKey).toString('hex')};},machine=key(),device=key(),expires=Date.now()+3600000;
 const path=join(paired,'authority.db'),pins=new DatabaseSync(path);chmodSync(path,0o600);pins.exec('CREATE TABLE machine(id,pub,secret); CREATE TABLE grants(route,device,expires,state,context,relayTicket)');pins.prepare('INSERT INTO machine VALUES(1,?,?)').run(machine.publicKey,machine.secretKey);pins.prepare("INSERT INTO grants VALUES(?,?,?,'active','synthetic','synthetic')").run(pairRoute,device.publicKey,expires);
 local.storage.set('machine.agent.v1.'+owner,JSON.stringify({key:device,grant:{route:pairRoute,device:device.publicKey,machine:machine.publicKey,deviceTicket:randomBytes(32).toString('hex')},expires}));
 let authority=new BeeperReadAuthority({directory:state,pairingDirectory:paired}),journal:BeeperForegroundJournal|undefined,clear:(()=>void)|undefined,source:Awaited<ReturnType<typeof listen>>|undefined,relay:Awaited<ReturnType<typeof listen>>|undefined;
 const query=async(q:string,p:Record<string,unknown>={})=>{const s=driver!.session();try{return await s.run(q,p);}finally{await s.close();}};
 try{
  const service=await import('../src/services/beeperRelay.js'),imports=await import('../src/services/importedChats.js'),s=driver!.session();try{await service.ensureBeeperReadSchema(s);await imports.ensureImportedChatSchema(s);}finally{await s.close();}
  await query('CREATE(:User {id:$owner})',{owner});
  const app=express(),routes=await import('../src/routes/beeper.js'),{exceptImportBody}=await import('../src/routes/importedChats.js');app.use(exceptImportBody(express.json()));app.use('/api/beeper/relay',routes.beeperRelayRoutes);app.use('/api/beeper',routes.beeperOwnerRoutes);relay=await listen(app);
  const auth='Bearer '+jwt.sign({userId:owner,email:'synthetic@example.test'},process.env.JWT_SECRET||'dev-secret-change-me');
  const post=async(path:string,body:unknown)=>{const r=await fetch(`http://127.0.0.1:${relay!.port}/api/beeper${path}`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body)});expect(r.ok).toBe(true);return r.json();};
  const {publicOffer,relayToken}=await authority.approveCatalogue({pairRoute,ownerId:owner,accountId:'synthetic-local-account',expiresAt:expires-1000,destination:'https://chat.ideaflow.app'},async()=>true);
  await post('/connections',{offer:publicOffer});
  let lost=true,sourceGets=0,delivered=0;
  const transport=createBeeperRelayTransport({readToken:async()=>relayToken,fetchImpl:async(url:string,options:RequestInit)=>{
   const u=new URL(url);expect(u.origin).toBe('https://chat.ideaflow.app');expect(options.redirect).toBe('error');
   const r=await fetch(`http://127.0.0.1:${relay!.port}${u.pathname}`,options);
   if(u.pathname.endsWith('/deliver')){delivered++;if(lost){lost=false;await r.arrayBuffer();throw Error('lost ACK after durable graph commit');}}
   return r;
  }});
  const localChat={id:'synthetic-local-chat',accountID:'synthetic-local-account',network:'whatsapp',type:'group',title:'Synthetic selected chat'};
  const sourceApp=express();sourceApp.get('/v1/chats',(_req,res)=>res.json({items:[localChat],hasMore:false}));sourceApp.get('/v1/chats/:chat/messages',(req,res)=>{expect(req.params.chat).toBe(localChat.id);expect(req.headers.authorization).toBe('Bearer synthetic-source-token');sourceGets++;res.json({items:[{id:'synthetic-message',accountID:localChat.accountID,chatID:localChat.id,senderID:'synthetic-sender',timestamp:'2026-11-26T00:00:00Z',text:'Synthetic flow body'}],hasMore:false,newestCursor:'local-new',oldestCursor:'local-old'});});source=await listen(sourceApp);
  const adapter=createBeeperReadonlyClient({readToken:async()=>'synthetic-source-token',port:source.port});
  await authority.readCatalogue(publicOffer.connectionId,adapter,(body:any,beforeFetch:any)=>transport.publishCatalogue(body,beforeFetch));
  const {wire}=await authority.approveChat(publicOffer.connectionId,localChat,async()=>true);
  await acceptBeeperReadOffer(owner,wire,async(scope)=>scope.title===localChat.title);clear=enableBeeperReadRegistry(owner);
  const catalogue=await(await fetch(`http://127.0.0.1:${relay.port}/api/beeper/connections/${publicOffer.connectionId}/chats`,{headers:{Authorization:auth}})).json(),entry=catalogue.items[0];
  const job=await post(`/connections/${publicOffer.connectionId}/reads`,{chatKey:entry.chatKey,clientRequestId:'full-flow',kind:'open'}),connection={...publicOffer,id:publicOffer.connectionId,state:'active'};
  const frame=await authorizeBeeperRead(connection as any,job,entry,owner);
  const attached=await fetch(`http://127.0.0.1:${relay.port}/api/beeper/connections/${publicOffer.connectionId}/reads/${job.id}/intent`,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({frame})});expect(attached.status).toBe(200);
  journal=new BeeperForegroundJournal(state);
  const run=()=>createBeeperForegroundRunner({connectionId:publicOffer.connectionId,transport,authority,adapter,journal});
  expect(await run().runOne()).toMatchObject({status:'retry',reason:'relay_unavailable'});expect(sourceGets).toBe(1);expect(journal.get(publicOffer.connectionId)?.claim.id).toBe(job.id);
  const durable=await query('MATCH(j:OpenChatBeeperJob {id:$id}) RETURN j.state AS state',{id:job.id});expect(durable.records[0]!.get('state')).toBe('done');
  journal.close();authority.close();authority=new BeeperReadAuthority({directory:state,pairingDirectory:paired});journal=new BeeperForegroundJournal(state);
  expect(await run().runOne()).toMatchObject({status:'complete',jobId:job.id});expect(sourceGets).toBe(1);expect(delivered).toBe(2);expect(journal.get(publicOffer.connectionId)).toBeNull();
  const rows=await query('MATCH(m:OpenChatImportedMessage {ownerUserId:$owner}) RETURN m.text AS text',{owner});expect(rows.records.map(r=>r.get('text'))).toEqual(['Synthetic flow body']);
  expect((await fetch(`http://127.0.0.1:${relay.port}/api/beeper/connections/${publicOffer.connectionId}/chats`,{headers:{Authorization:'Bearer '+jwt.sign({userId:owner+'-other'},process.env.JWT_SECRET||'dev-secret-change-me')}})).status).toBe(404);
  const refresh=await post(`/connections/${publicOffer.connectionId}/reads`,{chatKey:entry.chatKey,clientRequestId:'revoke-during-token',kind:'refresh'}),refreshIntent=await authorizeBeeperRead(connection as any,refresh,entry,owner);
  expect((await fetch(`http://127.0.0.1:${relay.port}/api/beeper/connections/${publicOffer.connectionId}/reads/${refresh.id}/intent`,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({frame:refreshIntent})})).status).toBe(200);
  const revokedAdapter=createBeeperReadonlyClient({port:source.port,readToken:async()=>{pins.prepare("UPDATE grants SET state='revoked' WHERE route=?").run(pairRoute);return 'synthetic-source-token';}});
  const denied=createBeeperForegroundRunner({connectionId:publicOffer.connectionId,transport,authority,adapter:revokedAdapter,journal});
  expect(await denied.runOne()).toMatchObject({status:'blocked',reason:'local_approval_required'});expect(sourceGets).toBe(1);expect(delivered).toBe(2);
 }finally{
  clear?.();journal?.close();authority.close();pins.close();if(source)await close(source.server);if(relay)await close(relay.server);await query('MATCH(n) WHERE n.ownerUserId=$owner OR (n:User AND n.id=$owner) DETACH DELETE n',{owner});local.storage.clear();rmSync(dir,{recursive:true,force:true});
 }
});
