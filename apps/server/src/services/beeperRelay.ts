import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import neo4j,{type ManagedTransaction,type Session} from 'neo4j-driver';
import {getDriver} from '../db.js';
import {importChatInTransaction,parseImportPayload} from './importedChats.js';

/** The relay is a private importer, never a machine-control authority. A queued
 * intent is opaque ciphertext. The Mac independently authenticates its device,
 * protocol, grant and immutable selected-chat scope before any source read. */
export class BeeperRelayError extends Error {
  constructor(public status:number,public code:string){super(code);}
}
const fail=(status:number,code:string):never=>{throw new BeeperRelayError(status,code);};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const hex=(value:unknown,size:number):value is string=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max
  &&!Array.from(value).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);
const number=(value:unknown)=>Number(value??0);
const now=()=>new Date().toISOString();
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail(400,'invalid_request');
const safeFrame=(value:unknown):value is string=>typeof value==='string'&&value.length>=56&&value.length<=48000&&/^[A-Za-z0-9+/]+={0,2}$/.test(value);
function plain(value:unknown):unknown{
  if(neo4j.isInt(value))return value.toNumber();
  if(Array.isArray(value))return value.map(plain);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,plain(v)]));
  return value;
}
export function canonicalBeeperJson(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalBeeperJson).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalBeeperJson((value as Record<string,unknown>)[key])).join(',')+'}';
}
export const beeperPayloadDigest=(value:unknown)=>hash(canonicalBeeperJson(value));
type Tx=ManagedTransaction;
type Connection={catalogueReportedAt?:string;catalogueEmpty?:boolean;network?:'whatsapp'|'imessage';id:string;ownerUserId:string;accountKey:string;machineKey:string;deviceKey:string;catalogueGrantId:string;expiresAt:string;state:string;protocol:string;destination:string;relayBinding:string};

/** Public local offer contains verifiers/public keys only. Its creation and
 * approval are actual owner actions; source installation never enrolls a Mac. */
export interface BeeperReadOffer {
  protocol:'openchat.beeper.read.v1'|'openchat.beeper.imessage.read.v1';network?:'imessage';connectionId:string;machineKey:string;deviceKey:string;
  accountKey:string;catalogueGrantId:string;relayTokenHash:string;relayBinding:string;ownerUserId:string;expiresAt:string;destination:'https://chat.ideaflow.app';
}
export function parseBeeperReadOffer(body:unknown):BeeperReadOffer {
  const v=object(body),until=typeof v.expiresAt==='string'?Date.parse(v.expiresAt):NaN;
  const fields=[...(v.protocol==='openchat.beeper.imessage.read.v1'?['network']:[]),'protocol','connectionId','ownerUserId','machineKey','deviceKey','accountKey','catalogueGrantId','relayTokenHash','relayBinding','expiresAt','destination'];
  if(Object.keys(v).length!==fields.length||Object.keys(v).some(key=>!fields.includes(key)))fail(400,'invalid_or_expired_offer');
  if(!((v.protocol==='openchat.beeper.read.v1'&&v.network===undefined)||(v.protocol==='openchat.beeper.imessage.read.v1'&&v.network==='imessage'))||v.destination!=='https://chat.ideaflow.app'||!hex(v.connectionId,48)||!hex(v.machineKey,64)||!hex(v.deviceKey,64)
    ||!hex(v.accountKey,64)||!hex(v.catalogueGrantId,48)||!hex(v.relayTokenHash,64)||!hex(v.relayBinding,64)||!bounded(v.ownerUserId,200)
    ||!Number.isFinite(until)||until<=Date.now()||until>Date.now()+7*86400000)fail(400,'invalid_or_expired_offer');
  return v as unknown as BeeperReadOffer;
}

/** Bound to the locally approved recipient/source tuple, not an editable public offer. */
export function beeperRelayBinding(token:string,offer:Pick<BeeperReadOffer,'protocol'|'connectionId'|'ownerUserId'|'machineKey'|'deviceKey'|'accountKey'|'catalogueGrantId'|'expiresAt'|'destination'|'network'>){
  return createHmac('sha256',token).update(JSON.stringify([offer.protocol,offer.connectionId,offer.ownerUserId,offer.machineKey,offer.deviceKey,offer.accountKey,offer.catalogueGrantId,offer.expiresAt,offer.destination,...(offer.protocol==='openchat.beeper.imessage.read.v1'?[offer.network]:[])])).digest('hex');
}

function approvedNetwork(c:{protocol:string;network?:string|null}):'whatsapp'|'imessage'{
  if(c.protocol==='openchat.beeper.read.v1'&&(c.network==null||c.network==='whatsapp'))return 'whatsapp';
  if(c.protocol==='openchat.beeper.imessage.read.v1'&&c.network==='imessage')return 'imessage';
  return fail(403,'source_network_mismatch');
}
function publicJob(value:unknown):Record<string,unknown>|null {
  const job=plain(value) as Record<string,unknown>|null;
  // Do not add new fields to the legacy WhatsApp claim wire: old Mac verifiers
  // deliberately reject unknown claim fields. New iMessage jobs carry network.
  if(job&&(job.network==null||job.network==='whatsapp'))delete job.network;
  return job;
}

export async function ensureBeeperReadSchema(session:Session){
  for(const [name,label,property] of [
    ['connection_id','OpenChatBeeperConnection','id'],['relay_token_hash','OpenChatBeeperConnection','relayTokenHash'],
    ['catalogue_key','OpenChatBeeperCatalogue','key'],['job_id','OpenChatBeeperJob','id'],['receipt_key','OpenChatBeeperReceipt','key'],
  ]) await session.run(`CREATE CONSTRAINT openchat_beeper_${name} IF NOT EXISTS FOR(n:${label}) REQUIRE n.${property} IS UNIQUE`);
}

async function ownerLock(tx:Tx,ownerUserId:string):Promise<void>{
  const r=await tx.run(`MATCH(u:User {id:$ownerUserId}) SET u.importedChatsRevision=coalesce(u.importedChatsRevision,0)+1 RETURN u.id AS id`,{ownerUserId});
  if(!r.records.length)fail(404,'account_not_available');
}
async function transaction<T>(action:(tx:Tx)=>Promise<T>):Promise<T>{
  const s=getDriver().session();try{return await s.executeWrite(action);}finally{await s.close();}
}
async function connection(tx:Tx,ownerUserId:string,connectionId:string):Promise<Connection>{
  const r=await tx.run(`MATCH(c:OpenChatBeeperConnection {id:$connectionId,ownerUserId:$ownerUserId})
    SET c.revision=coalesce(c.revision,0)+1 RETURN c{.id,.ownerUserId,.accountKey,.machineKey,.deviceKey,.catalogueGrantId,.expiresAt,.state,.protocol,.network,.catalogueReportedAt,.catalogueEmpty,.destination,.relayBinding} AS c`,{ownerUserId,connectionId});
  if(!r.records.length)fail(404,'connection_not_available');
  return r.records[0]!.get('c') as Connection;
}
function active(c:Connection){if(c.state!=='active'||Date.parse(c.expiresAt)<=Date.now())fail(403,'connection_revoked_or_expired');}
async function ownerConnection<T>(ownerUserId:string,connectionId:string,action:(tx:Tx,c:Connection)=>Promise<T>){
  return transaction(async tx=>{await ownerLock(tx,ownerUserId);return action(tx,await connection(tx,ownerUserId,connectionId));});
}
/** The token only reaches this dedicated importer. All existing app/agent
 * authenticators reject its ocbr_ prefix. Every mutation rechecks the persisted
 * grant under owner -> connection locks; middleware caching is not authority. */
async function relay<T>(token:string,action:(tx:Tx,c:Connection)=>Promise<T>):Promise<T>{
  if(!/^ocbr_[A-Za-z0-9_-]{43}$/.test(token))fail(401,'relay_not_authorized');
  const tokenHash=hash(token),s=getDriver().session();
  let ownerUserId:string,connectionId:string;
  try{
    const r=await s.run(`MATCH(c:OpenChatBeeperConnection {relayTokenHash:$tokenHash}) RETURN c.ownerUserId AS owner,c.id AS id`,{tokenHash});
    if(r.records.length!==1)fail(401,'relay_not_authorized');
    ownerUserId=r.records[0]!.get('owner');connectionId=r.records[0]!.get('id');
  }finally{await s.close();}
  return ownerConnection(ownerUserId!,connectionId!,async(tx,c)=>{
    active(c);
    approvedNetwork(c);
    const expected=beeperRelayBinding(token,{...c,connectionId:c.id} as BeeperReadOffer);
    if(c.destination!=='https://chat.ideaflow.app'||!hex(c.relayBinding,64)||!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(c.relayBinding,'hex')))fail(403,'relay_owner_binding_mismatch');
    const r=await tx.run(`MATCH(c:OpenChatBeeperConnection {id:$connectionId,ownerUserId:$ownerUserId,relayTokenHash:$tokenHash}) RETURN c.id AS id`,{connectionId,ownerUserId,tokenHash});
    if(!r.records.length)fail(401,'relay_not_authorized');return action(tx,c);
  });
}
export async function verifyBeeperRelayToken(token:string){return relay(token,async(_tx,c)=>({connectionId:c.id}));}

export async function approveBeeperReadConnection(ownerUserId:string,body:unknown){
  const offer=parseBeeperReadOffer(body);
  if(offer.ownerUserId!==ownerUserId)fail(403,'source_owner_mismatch');
  return transaction(async tx=>{
    await ownerLock(tx,ownerUserId);
    const r=await tx.run(`MATCH(u:User {id:$ownerUserId})
      MERGE(c:OpenChatBeeperConnection {id:$id})
      ON CREATE SET c.ownerUserId=$ownerUserId,c.accountKey=$accountKey,c.machineKey=$machineKey,c.deviceKey=$deviceKey,
        c.catalogueGrantId=$catalogueGrantId,c.relayTokenHash=$relayTokenHash,c.relayBinding=$relayBinding,
        c.protocol=$protocol,c.network=$network,c.destination=$destination,c.expiresAt=$expiresAt,c.state='active',c.createdAt=$now
      RETURN c.ownerUserId=$ownerUserId AND c.accountKey=$accountKey AND c.machineKey=$machineKey
        AND c.deviceKey=$deviceKey AND c.catalogueGrantId=$catalogueGrantId AND c.expiresAt=$expiresAt
        AND c.relayTokenHash=$relayTokenHash AND c.relayBinding=$relayBinding AND c.protocol=$protocol AND coalesce(c.network,'whatsapp')=$network AND c.destination=$destination AND c.state='active' AS same`,
    {...offer,network:approvedNetwork(offer),ownerUserId,id:offer.connectionId,now:now()});
    if(r.records[0]?.get('same')!==true)fail(409,'connection_already_bound');
    return {id:offer.connectionId,state:'active',accountKey:offer.accountKey,expiresAt:offer.expiresAt};
  });
}

export async function listBeeperReadConnections(ownerUserId:string){
  const s=getDriver().session();try{
    const r=await s.run(`MATCH(c:OpenChatBeeperConnection {ownerUserId:$ownerUserId})
      RETURN c{.id,.accountKey,.machineKey,.deviceKey,.expiresAt,.state,.protocol,network:coalesce(c.network,'whatsapp'),.catalogueReportedAt,.catalogueEmpty,.heartbeatAt,.lastSuccessAt,.lastError} AS c ORDER BY c.createdAt DESC`,{ownerUserId});
    return r.records.map(row=>row.get('c'));
  }finally{await s.close();}
}

export async function revokeBeeperReadConnection(ownerUserId:string,connectionId:string){
  return ownerConnection(ownerUserId,connectionId,async tx=>{
    await tx.run(`MATCH(c:OpenChatBeeperConnection {id:$connectionId,ownerUserId:$ownerUserId}) SET c.state='revoked',c.relayTokenHash=null,c.revokedAt=$now
      WITH c OPTIONAL MATCH(j:OpenChatBeeperJob {connectionId:c.id,ownerUserId:$ownerUserId}) WHERE j.state IN ['pending','leased']
      SET j.state='cancelled',j.leaseId=null,j.leaseUntil=null`,{ownerUserId,connectionId,now:now()});
    return {ok:true};
  });
}

export async function publishBeeperCatalogue(token:string,body:unknown){
  const v=object(body),items=v.items;
  if(!Array.isArray(items)||items.length>200||typeof v.complete!=='boolean')fail(400,'invalid_catalogue');
  const entries=(items as unknown[]).map(raw=>{
    const r=object(raw),capturedAt=typeof r.capturedAt==='string'&&Number.isFinite(Date.parse(r.capturedAt))?new Date(r.capturedAt).toISOString():fail(400,'invalid_catalogue');
    if(!hex(r.chatKey,64)||!hex(r.accountKey,64)||!['whatsapp','imessage'].includes(r.network as string)||!['direct','group'].includes(r.chatType as string)||!bounded(r.title,200))fail(400,'invalid_catalogue');
    const lastActivityAt=r.lastActivityAt===null?null:typeof r.lastActivityAt==='string'&&Number.isFinite(Date.parse(r.lastActivityAt))?new Date(r.lastActivityAt).toISOString():fail(400,'invalid_catalogue');
    // Whitelist, never persist previews/rosters/source IDs/URLs from a payload.
    return {chatKey:r.chatKey as string,accountKey:r.accountKey as string,network:r.network as string,chatType:r.chatType as string,title:r.title as string,capturedAt,lastActivityAt};
  });
  return relay(token,async(tx,c)=>{
    if(entries.some(e=>e.accountKey!==c.accountKey||e.network!==approvedNetwork(c)))fail(403,'source_scope_mismatch');
    const poisoned=await tx.run(`MATCH(e:OpenChatBeeperCatalogue {connectionId:$connectionId,ownerUserId:$ownerUserId})
      WHERE coalesce(e.network,'whatsapp')<>$network RETURN count(e) AS n`,{connectionId:c.id,ownerUserId:c.ownerUserId,network:approvedNetwork(c)});
    if(number(poisoned.records[0]?.get('n')))fail(403,'source_network_mismatch');
    await tx.run(`UNWIND $entries AS row
      MERGE(e:OpenChatBeeperCatalogue {key:row.key})
      ON CREATE SET e.ownerUserId=$ownerUserId,e.connectionId=$connectionId,e.chatKey=row.chatKey,e.scanEpoch=0
      SET e.accountKey=row.accountKey,e.network=row.network,e.chatType=row.chatType,e.title=row.title,
        e.sourceReadAt=row.capturedAt,e.lastActivityAt=row.lastActivityAt,e.receivedAt=$now
      WITH count(e) AS ignored MATCH(c:OpenChatBeeperConnection {id:$connectionId}) SET c.heartbeatAt=$now,c.lastError=null,c.catalogueReportedAt=$now,c.catalogueEmpty=$empty`,
    {empty:entries.length===0,connectionId:c.id,ownerUserId:c.ownerUserId,entries:entries.map(e=>({...e,key:hash(JSON.stringify([c.id,e.chatKey]))})),now:now()});
    return {accepted:entries.length};
  });
}

export async function listBeeperCatalogue(ownerUserId:string,connectionId:string,options:{cursor?:unknown;search?:unknown;chatKey?:unknown}={}){
  const cursor=options.cursor??'',search=options.search??'',chatKey=options.chatKey??'';
  if((cursor!==''&&!hex(cursor,64))||(search!==''&&!bounded(search,100))||(chatKey!==''&&!hex(chatKey,64)))fail(400,'invalid_catalogue_query');
  return ownerConnection(ownerUserId,connectionId,async(tx,c)=>{
    const r=await tx.run(`MATCH(e:OpenChatBeeperCatalogue {connectionId:$connectionId,ownerUserId:$ownerUserId})
      WHERE e.network=$network AND ($cursor='' OR e.chatKey>$cursor) AND ($search='' OR toLower(e.title) CONTAINS toLower($search)) AND ($chatKey='' OR e.chatKey=$chatKey)
      OPTIONAL MATCH(chat:OpenChatImportedChat {ownerUserId:$ownerUserId,relayConnectionId:$connectionId,chatKey:e.chatKey,network:e.network})
      RETURN e{.chatKey,.title,.chatType,.network,.lastActivityAt,.sourceReadAt,.receivedAt,importedChatId:chat.id} AS entry ORDER BY e.chatKey LIMIT 201`,{ownerUserId,connectionId,network:approvedNetwork(c),cursor,search,chatKey});
    const items=r.records.slice(0,200).map(row=>row.get('entry'));
    return {connection:{id:c.id,state:c.state,expiresAt:c.expiresAt,protocol:c.protocol,network:approvedNetwork(c),catalogueReportedAt:c.catalogueReportedAt,catalogueEmpty:c.catalogueEmpty},items,nextCursor:r.records.length>200?items.at(-1).chatKey:null};
  });
}

/** Reserve a scan first. The paired device then seals the exact job/epoch in
 * its typed readSelected intent; a relay cannot mint that operation itself. */
export async function requestBeeperRead(ownerUserId:string,connectionId:string,body:unknown){
  const v=object(body);
  if(!hex(v.chatKey,64)||!bounded(v.clientRequestId,200)||!['open','refresh','earlier'].includes(v.kind as string))fail(400,'invalid_request');
  return ownerConnection(ownerUserId,connectionId,async(tx,c)=>{
    active(c);
    // Retain operation metadata/receipts for seven days, never source bodies.
    // Canonical imported chat/history and the monotonically increasing epoch survive.
    const cutoff=new Date(Date.now()-7*86400000).toISOString();
    await tx.run(`MATCH(r:OpenChatBeeperReceipt {ownerUserId:$ownerUserId,connectionId:$connectionId}) WHERE r.createdAt<$cutoff DETACH DELETE r`,{ownerUserId,connectionId,cutoff});
    await tx.run(`MATCH(j:OpenChatBeeperJob {ownerUserId:$ownerUserId,connectionId:$connectionId}) WHERE j.state IN ['done','failed','cancelled'] AND j.createdAt<$cutoff DETACH DELETE j`,{ownerUserId,connectionId,cutoff});
    const existing=await tx.run(`MATCH(j:OpenChatBeeperJob {ownerUserId:$ownerUserId,connectionId:$connectionId,chatKey:$chatKey})
      WHERE coalesce(j.network,'whatsapp')=$network AND (j.clientRequestId=$request OR j.state IN ['pending','leased']) RETURN j{.id,.epoch,.state,.nextSequence,.kind,.network} AS j ORDER BY j.createdAt DESC LIMIT 1`,
    {ownerUserId,connectionId,chatKey:v.chatKey,network:approvedNetwork(c),request:v.clientRequestId});
    if(existing.records.length)return publicJob(existing.records[0]!.get('j'));
    const size=await tx.run(`MATCH(j:OpenChatBeeperJob {ownerUserId:$ownerUserId,connectionId:$connectionId}) WHERE j.state IN ['pending','leased'] RETURN count(j) AS n`,{ownerUserId,connectionId});
    if(number(size.records[0]?.get('n'))>=4)fail(429,'too_many_pending_scans');
    const r=await tx.run(`MATCH(e:OpenChatBeeperCatalogue {ownerUserId:$ownerUserId,connectionId:$connectionId,chatKey:$chatKey})
      WHERE e.network=$network AND e.accountKey=$accountKey
      SET e.scanEpoch=coalesce(e.scanEpoch,0)+1
      CREATE(j:OpenChatBeeperJob {id:$id,ownerUserId:$ownerUserId,connectionId:$connectionId,accountKey:e.accountKey,chatKey:e.chatKey,network:$network,
        epoch:e.scanEpoch,clientRequestId:$request,kind:$kind,state:'pending',nextSequence:0,createdAt:$now})
      RETURN j{.id,.epoch,.state,.nextSequence,.kind,.network} AS j`,
    {ownerUserId,connectionId,chatKey:v.chatKey,network:approvedNetwork(c),accountKey:c.accountKey,id:randomBytes(24).toString('hex'),request:v.clientRequestId,kind:v.kind,now:now()});
    if(!r.records.length)fail(404,'chat_not_available');return publicJob(r.records[0]!.get('j'));
  });
}

export async function attachBeeperReadIntent(ownerUserId:string,connectionId:string,jobId:string,frame:unknown){
  if(!safeFrame(frame))fail(400,'invalid_intent');
  return ownerConnection(ownerUserId,connectionId,async(tx,c)=>{
    active(c);const r=await tx.run(`MATCH(j:OpenChatBeeperJob {id:$jobId,ownerUserId:$ownerUserId,connectionId:$connectionId,state:'pending'})
      WHERE coalesce(j.network,'whatsapp')=$network AND (j.intent IS NULL OR j.intent=$frame) SET j.intent=$frame RETURN j.id AS id`,{jobId,ownerUserId,connectionId,network:approvedNetwork(c),frame});
    if(!r.records.length)fail(409,'scan_already_started');return {ok:true};
  });
}

export async function claimBeeperRead(token:string){
  return relay(token,async(tx,c)=>{
    const stamp=now(),leaseId=randomBytes(24).toString('hex'),leaseUntil=new Date(Date.now()+60000).toISOString();
    const busy=await tx.run(`MATCH(j:OpenChatBeeperJob {connectionId:$connectionId,ownerUserId:$ownerUserId,state:'leased'}) WHERE j.leaseUntil>$now RETURN count(j) AS n`,{connectionId:c.id,ownerUserId:c.ownerUserId,now:stamp});
    if(number(busy.records[0]?.get('n'))>=2)return {job:null};
    const r=await tx.run(`MATCH(j:OpenChatBeeperJob {connectionId:$connectionId,ownerUserId:$ownerUserId})
      WHERE coalesce(j.network,'whatsapp')=$network AND j.intent IS NOT NULL AND (j.state='pending' OR (j.state='leased' AND j.leaseUntil<$now))
      WITH j ORDER BY j.createdAt,j.id LIMIT 1
      SET j.state='leased',j.leaseId=$leaseId,j.leaseUntil=$leaseUntil
      RETURN j{.id,.accountKey,.chatKey,.network,.epoch,.kind,.intent,.nextSequence,.leaseId,.leaseUntil} AS job`,
    {connectionId:c.id,ownerUserId:c.ownerUserId,network:approvedNetwork(c),now:stamp,leaseId,leaseUntil});
    await tx.run(`MATCH(c:OpenChatBeeperConnection {id:$id}) SET c.heartbeatAt=$now`,{id:c.id,now:stamp});
    return {job:publicJob(r.records[0]?.get('job')??null)};
  });
}

/** Resume one locally journalled read, including receipt replay after the final
 * ACK was lost. This creates no machine authority and never selects another job. */
export async function resumeBeeperRead(token:string,body:unknown){
  const v=object(body);
  if(!hex(v.jobId,48)||Object.keys(v).length!==1)fail(400,'invalid_request');
  return relay(token,async(tx,c)=>{
    const row=await tx.run(`MATCH(j:OpenChatBeeperJob {id:$jobId,connectionId:$connectionId,ownerUserId:$ownerUserId})
      SET j.revision=coalesce(j.revision,0)+1 RETURN j{.*} AS j`,{jobId:v.jobId,connectionId:c.id,ownerUserId:c.ownerUserId});
    if(!row.records.length)fail(404,'scan_not_available');const j=row.records[0]!.get('j') as Record<string,unknown>;
    if(!j.intent||!['pending','leased','done'].includes(j.state as string))fail(409,'scan_superseded');
    const current=await tx.run(`MATCH(e:OpenChatBeeperCatalogue {connectionId:$connectionId,ownerUserId:$ownerUserId,chatKey:$chatKey}) RETURN e.scanEpoch AS epoch,e.network AS network`,{connectionId:c.id,ownerUserId:c.ownerUserId,chatKey:j.chatKey});
    if(j.accountKey!==c.accountKey||(j.network??'whatsapp')!==approvedNetwork(c)||current.records[0]?.get('network')!==approvedNetwork(c)||number(current.records[0]?.get('epoch'))!==number(j.epoch))fail(409,'scan_superseded');
    if(j.state!=='done'&&(j.state!=='leased'||String(j.leaseUntil)<=now())){
      const busy=await tx.run(`MATCH(j:OpenChatBeeperJob {connectionId:$connectionId,ownerUserId:$ownerUserId,state:'leased'}) WHERE j.leaseUntil>$now RETURN count(j) AS n`,{connectionId:c.id,ownerUserId:c.ownerUserId,now:now()});
      if(number(busy.records[0]?.get('n'))>=2)fail(429,'too_many_pending_scans');
      await tx.run(`MATCH(j:OpenChatBeeperJob {id:$id}) SET j.state='leased',j.leaseId=$leaseId,j.leaseUntil=$leaseUntil`,{id:j.id,leaseId:randomBytes(24).toString('hex'),leaseUntil:new Date(Date.now()+60000).toISOString()});
    }
    const result=await tx.run(`MATCH(j:OpenChatBeeperJob {id:$id,connectionId:$connectionId,ownerUserId:$ownerUserId}) RETURN j{.id,.accountKey,.chatKey,.network,.epoch,.kind,.intent,.nextSequence,.leaseId,.leaseUntil} AS job`,{id:j.id,connectionId:c.id,ownerUserId:c.ownerUserId});
    return {job:publicJob(result.records[0]!.get('job'))};
  });
}

export async function deliverBeeperRead(token:string,body:unknown){
  const v=object(body),payload=parseImportPayload(v.payload);
  if(!hex(v.jobId,48)||!hex(v.leaseId,48)||!hex(v.digest,64)||!Number.isSafeInteger(v.sequence)||number(v.sequence)<0||typeof v.final!=='boolean')fail(400,'invalid_batch');
  if(payload.messages.length>100||Buffer.byteLength(JSON.stringify(v),'utf8')>1024*1024||payload.coverage.complete||!['whatsapp','imessage'].includes(payload.source.network))fail(400,'invalid_batch');
  const digest=beeperPayloadDigest({payload:v.payload,final:v.final});if(digest!==v.digest)fail(409,'batch_digest_mismatch');
  return relay(token,async(tx,c)=>{
    const r=await tx.run(`MATCH(j:OpenChatBeeperJob {id:$jobId,ownerUserId:$ownerUserId,connectionId:$connectionId})
      SET j.revision=coalesce(j.revision,0)+1 RETURN j{.*} AS job`,{jobId:v.jobId,ownerUserId:c.ownerUserId,connectionId:c.id});
    if(!r.records.length)fail(404,'scan_not_available');const j=r.records[0]!.get('job') as Record<string,unknown>;
    if((j.network??'whatsapp')!==approvedNetwork(c)||payload.source.network!==approvedNetwork(c)||j.accountKey!==c.accountKey||payload.source.accountKey!==c.accountKey||payload.source.chatKey!==j.chatKey)fail(403,'source_scope_mismatch');
    const current=await tx.run(`MATCH(e:OpenChatBeeperCatalogue {connectionId:$connectionId,ownerUserId:$ownerUserId,chatKey:$chatKey}) RETURN e.scanEpoch AS epoch,e.network AS network`,{connectionId:c.id,ownerUserId:c.ownerUserId,chatKey:j.chatKey});
    if(current.records[0]?.get('network')!==approvedNetwork(c)||number(current.records[0]?.get('epoch'))!==number(j.epoch)||['cancelled','failed'].includes(j.state as string))fail(409,'scan_superseded');
    const key=hash(JSON.stringify([c.id,j.id,v.sequence]));
    const receipt=await tx.run(`MATCH(r:OpenChatBeeperReceipt {key:$key,ownerUserId:$ownerUserId}) RETURN r.digest AS digest,r.chatId AS chatId,r.sequence AS sequence`,{key,ownerUserId:c.ownerUserId});
    if(receipt.records.length){if(receipt.records[0]!.get('digest')!==digest)fail(409,'batch_sequence_conflict');return {chatId:receipt.records[0]!.get('chatId'),sequence:number(v.sequence),duplicate:true};}
    if(j.state!=='leased'||j.leaseId!==v.leaseId||String(j.leaseUntil)<=now()||number(j.nextSequence)!==number(v.sequence))fail(409,'lease_or_sequence_not_current');
    const result=await importChatInTransaction(tx,c.ownerUserId,payload,{importedBy:'beeper-readonly-relay',relay:{connectionId:c.id,epoch:number(j.epoch)}});
    if(result.conflicts.length)fail(409,'source_reconciliation_required');
    const stamp=now();
    await tx.run(`MATCH(j:OpenChatBeeperJob {id:$jobId,ownerUserId:$ownerUserId}),(c:OpenChatBeeperConnection {id:$connectionId})
      CREATE(:OpenChatBeeperReceipt {key:$key,ownerUserId:$ownerUserId,connectionId:$connectionId,jobId:$jobId,sequence:$sequence,digest:$digest,chatId:$chatId,createdAt:$now})
      SET j.nextSequence=j.nextSequence+1,j.chatId=$chatId,j.lastBatchAt=$now,
        j.state=CASE WHEN $final THEN 'done' ELSE 'leased' END,
        j.completedAt=CASE WHEN $final THEN $now ELSE null END,j.leaseUntil=$leaseUntil,
        c.heartbeatAt=$now,c.lastError=null,
        c.lastSuccessAt=CASE WHEN $final THEN $now ELSE c.lastSuccessAt END`,
    {jobId:j.id,ownerUserId:c.ownerUserId,connectionId:c.id,key,sequence:neo4j.int(number(v.sequence)),digest,chatId:result.chatId,now:stamp,final:v.final,leaseUntil:new Date(Date.now()+60000).toISOString()});
    return {chatId:result.chatId,sequence:number(v.sequence),duplicate:false};
  });
}

export async function failBeeperRead(token:string,body:unknown){
  const v=object(body);
  if(!hex(v.jobId,48)||!hex(v.leaseId,48)||!['source_authorization_required','source_unavailable','source_incompatible','source_reconciliation_required','local_approval_required'].includes(v.code as string))fail(400,'invalid_failure');
  return relay(token,async(tx,c)=>{
    const r=await tx.run(`MATCH(j:OpenChatBeeperJob {id:$jobId,connectionId:$connectionId,ownerUserId:$ownerUserId,state:'leased',leaseId:$leaseId})
      WHERE j.leaseUntil>$now
      SET j.state='failed',j.lastError=$code,j.failedAt=$now,j.leaseId=null,j.leaseUntil=null
      WITH j MATCH(c:OpenChatBeeperConnection {id:$connectionId}) SET c.heartbeatAt=$now,c.lastError=$code
      RETURN j.id AS id`,{jobId:v.jobId,leaseId:v.leaseId,connectionId:c.id,ownerUserId:c.ownerUserId,code:v.code,now:now()});
    if(!r.records.length)fail(409,'lease_not_current');return {ok:true};
  });
}

export async function readBeeperJob(ownerUserId:string,connectionId:string,jobId:string){
  return ownerConnection(ownerUserId,connectionId,async tx=>{
    const r=await tx.run(`MATCH(j:OpenChatBeeperJob {id:$jobId,ownerUserId:$ownerUserId,connectionId:$connectionId})
      RETURN j{.id,.epoch,.kind,.network,.state,.nextSequence,.chatId,.createdAt,.lastBatchAt,.completedAt,.lastError} AS j`,{jobId,ownerUserId,connectionId});
    if(!r.records.length)fail(404,'scan_not_available');return publicJob(r.records[0]!.get('j'));
  });
}

/** Invoked only inside the existing account-deletion owner transaction. */
export async function deleteBeeperReadTransport(tx:Tx,ownerUserId:string){
  await tx.run(`MATCH(n) WHERE n.ownerUserId=$ownerUserId AND
    (n:OpenChatBeeperConnection OR n:OpenChatBeeperCatalogue OR n:OpenChatBeeperJob OR n:OpenChatBeeperReceipt) DETACH DELETE n`,{ownerUserId});
}

export async function exportBeeperReadTransport(tx:Tx,ownerUserId:string){
  const collections:Record<string,unknown[]>={};
  for(const [name,label,projection] of [
    ['connections','OpenChatBeeperConnection',".id,.accountKey,.machineKey,.deviceKey,.protocol,network:coalesce(n.network,'whatsapp'),.state,.expiresAt,.heartbeatAt,.lastSuccessAt,.lastError"],
    ['catalogue','OpenChatBeeperCatalogue','.connectionId,.chatKey,.network,.title,.chatType,.lastActivityAt,.sourceReadAt,.receivedAt'],
    ['jobs','OpenChatBeeperJob',".id,.connectionId,.chatKey,network:coalesce(n.network,'whatsapp'),.epoch,.kind,.state,.nextSequence,.chatId,.createdAt,.completedAt,.lastError"],
  ]){
    const r=await tx.run(`MATCH(n:${label} {ownerUserId:$ownerUserId}) RETURN n{${projection}} AS item`,{ownerUserId});
    collections[name!]=r.records.map(row=>row.get('item'));
  }
  return {scope:'all_time',...collections};
}
