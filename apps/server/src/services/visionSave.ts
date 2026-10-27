import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getDriver } from '../db.js';

export const ID_ISSUER = 'https://id.ideaflow.app/api/auth';
const HUB = 'https://id.ideaflow.app';
export type SaveStatus = 'saved'|'rejected'|'needs_auth'|'unavailable'|'uncertain';
export type SaveReceipt = {status:SaveStatus;destinationId?:string;url?:string;savedAt?:string;reason?:string;recoveryAvailable?:boolean};
export type SaveRequest = {destination:'vision';kind:'answer'|'summary'|'excerpt'|'note';title:string;body:string;sourceRefs:Array<{app:string;conversationId?:string;messageId?:string;sourceDigest?:string}>;visibility:'private';idempotencyKey:string;retryOf?:string};
export type Identity = {issuer:string;subject:string};
export type SaveRecord = {hash:string;receipt:SaveReceipt;phase?:string;selectionHash?:string;successorKey?:string};
export type SaveReservation = SaveRecord & {fresh:boolean;reservationId:string};
export type SaveReview = {status:'ready';sourceRefs:SaveRequest['sourceRefs'];sourceContents:string[]} | {status:'rejected'|'unavailable';reason:string};
export interface SaveRepository {
 identity(userId:string):Promise<Identity|null>;
 source(userId:string,conversationId:string,messageId:string):Promise<string|null>;
 lookup(userId:string,key:string):Promise<SaveRecord|null>;
 reserve(userId:string,key:string,hash:string,selectionHash:string,retryOf?:string):Promise<SaveReservation|null>;
 rejectBeforeDispatch(userId:string,key:string,reservationId:string,receipt:SaveReceipt):Promise<boolean>;
 beginDispatch(userId:string,key:string,reservationId:string):Promise<boolean>;
 finish(userId:string,key:string,receipt:SaveReceipt,reservationId:string):Promise<void>;
 token(userId:string):Promise<string|null>;
}
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const visionSaveMarker=(userId:string,key:string)=>'openchat-save:'+hash(JSON.stringify([userId,key]));
function searchableReceipt(receipt:SaveReceipt,userId:string,key:string):SaveReceipt {
 if(receipt.status!=='uncertain')return receipt;
 const marker=visionSaveMarker(userId,key);
 return {...receipt,reason:receipt.reason?.includes(marker)?receipt.reason:(receipt.reason??'Save acknowledgment unknown')+'; check Vision for '+marker};
}
function canonical(input:SaveRequest, legacy=false):string { return JSON.stringify([input.destination,input.kind,input.title,input.body,input.sourceRefs.map(r=>[r.app,r.conversationId??null,r.messageId??null,...(!legacy&&r.sourceDigest!==undefined?[r.sourceDigest]:[])]),input.visibility,...(input.retryOf?[input.retryOf]:[])]); }
function selectionHash(input:SaveRequest):string {return hash(canonical({...input,retryOf:undefined},true));}
function provenRejection(record:SaveRecord):boolean {
 return record.phase==='rejected_before_dispatch'&&record.receipt.status==='rejected'&&typeof record.selectionHash==='string'&&/^[a-f0-9]{64}$/.test(record.selectionHash);
}
function recoverable(record:SaveRecord|null,input:SaveRequest,nextKey?:string):boolean {
 return !!record&&provenRejection(record)&&record.selectionHash===selectionHash(input)&&(!record.successorKey||record.successorKey===nextKey);
}
function historicalReceipt(record:SaveRecord,userId:string,key:string):SaveReceipt {
 const {recoveryAvailable:_recoveryAvailable,...receipt}=record.receipt;
 return {...searchableReceipt(receipt,userId,key),...(provenRejection(record)?{recoveryAvailable:true}:{})};
}
function sealKey(token:string,userId:string):{ciphertext:string;iv:string} {
 const hex=process.env.OC_KEY_ENCRYPTION_SECRET;
 if(!hex||!/^[a-f0-9]{64}$/i.test(hex))throw Error('encryption_unavailable');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(hex,'hex'),iv);
 cipher.setAAD(Buffer.from('vision-save:'+userId));
 return {ciphertext:Buffer.concat([cipher.update(token,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('hex'),iv:iv.toString('hex')};
}
function openKey(row:{ciphertext:string;iv:string},userId:string):string|null {
 try { const hex=process.env.OC_KEY_ENCRYPTION_SECRET;if(!hex)return null;const bytes=Buffer.from(row.ciphertext,'hex'),cipher=createDecipheriv('aes-256-gcm',Buffer.from(hex,'hex'),Buffer.from(row.iv,'hex'));cipher.setAAD(Buffer.from('vision-save:'+userId));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(0,-16)),cipher.final()]).toString('utf8'); }catch{return null;}
}
export const neoSaveRepository:SaveRepository={
 async identity(userId){const db=getDriver().session();try{const r=await db.run('MATCH (u:User {id:$userId}) RETURN u.ideaflowIssuer AS issuer,u.ideaflowSub AS subject',{userId});const row=r.records[0];return row?.get('issuer')===ID_ISSUER&&typeof row.get('subject')==='string'?{issuer:ID_ISSUER,subject:row.get('subject')}:null;}finally{await db.close();}},
 async source(userId,conversationId,messageId){const db=getDriver().session();try{const r=await db.run(`MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(:Conversation {id:$conversationId}) MATCH (m:Message {id:$messageId,conversationId:$conversationId}) WHERE m.deletedAt IS NULL RETURN m.content AS content,m.transcript AS transcript`,{userId,conversationId,messageId});const row=r.records[0];return row?String(row.get('content')||row.get('transcript')||''):null;}finally{await db.close();}},
 async token(userId){const db=getDriver().session();try{const r=await db.run('MATCH (g:VisionSaveGrant {userId:$userId}) RETURN g.ciphertext AS ciphertext,g.iv AS iv',{userId});return r.records[0]?openKey({ciphertext:r.records[0].get('ciphertext'),iv:r.records[0].get('iv')},userId):null;}finally{await db.close();}},
 async lookup(userId,key){
  const db=getDriver().session();
  try{
   const r=await db.run('MATCH (s:VisionSaveReceipt {key:$key,userId:$userId}) RETURN s.hash AS hash,s.receipt AS receipt,s.phase AS phase,s.selectionHash AS selectionHash,s.successorKey AS successorKey',{userId,key:JSON.stringify([userId,key])});
   const row=r.records[0];
   return row?{hash:row.get('hash'),receipt:JSON.parse(row.get('receipt')),phase:row.get('phase'),selectionHash:row.get('selectionHash'),successorKey:row.get('successorKey')}:null;
  }finally{await db.close();}
 },
 async reserve(userId,key,payloadHash,selectionHash,retryOf){
  const db=getDriver().session(),reservationId=randomBytes(16).toString('hex');
  try{
   const predecessor=retryOf?`MATCH (previous:VisionSaveReceipt {key:$previousKey,userId:$userId})
    SET previous.recoveryLock=coalesce(previous.recoveryLock,0)+1
    WITH previous WHERE previous.phase='rejected_before_dispatch' AND previous.selectionHash=$selectionHash
      AND (previous.successorKey IS NULL OR previous.successorKey=$attemptKey)` : '';
   const result=await db.run(`${predecessor}
    MERGE (s:VisionSaveReceipt {key:$key})
    ON CREATE SET s.userId=$userId,s.hash=$payloadHash,s.selectionHash=$selectionHash,s.reservation=$reservationId,s.phase='reserved',s.receipt=$initial
    ${retryOf?`WITH s,previous WHERE s.hash=$payloadHash SET previous.successorKey=$attemptKey`:''}
    RETURN s.hash AS hash,s.reservation AS reservation,s.receipt AS receipt,s.phase AS phase,s.selectionHash AS selectionHash`,
    {userId,key:JSON.stringify([userId,key]),previousKey:retryOf?JSON.stringify([userId,retryOf]):null,attemptKey:key,payloadHash,selectionHash,reservationId,initial:JSON.stringify({status:'uncertain',reason:'Save attempt reserved; acknowledgment not yet known'})});
   const row=result.records[0];
   return row?{fresh:row.get('reservation')===reservationId,reservationId,hash:row.get('hash'),receipt:JSON.parse(row.get('receipt')),phase:row.get('phase'),selectionHash:row.get('selectionHash')}:null;
  }finally{await db.close();}
 },
 async rejectBeforeDispatch(userId,key,reservationId,receipt){
  const db=getDriver().session();
  try{
   const result=await db.run(`MATCH (s:VisionSaveReceipt {key:$key,userId:$userId,reservation:$reservationId,phase:'reserved'})
    SET s.phase='rejected_before_dispatch',s.receipt=$receipt RETURN s.key AS key`,{userId,key:JSON.stringify([userId,key]),reservationId,receipt:JSON.stringify(receipt)});
   return result.records.length===1;
  }finally{await db.close();}
 },
 async beginDispatch(userId,key,reservationId){
  const db=getDriver().session();
  try{
   const result=await db.run(`MATCH (s:VisionSaveReceipt {key:$key,userId:$userId,reservation:$reservationId,phase:'reserved'})
    SET s.phase='dispatching' RETURN s.key AS key`,{userId,key:JSON.stringify([userId,key]),reservationId});
   return result.records.length===1;
  }finally{await db.close();}
 },
 async finish(userId,key,receipt,reservationId){
  const db=getDriver().session();
  try{
   const result=await db.run(`MATCH (s:VisionSaveReceipt {key:$key,userId:$userId,reservation:$reservationId,phase:'dispatching'})
    SET s.phase='finished',s.receipt=$receipt RETURN s.key AS key`,{userId,key:JSON.stringify([userId,key]),reservationId,receipt:JSON.stringify(receipt)});
   if(result.records.length!==1)throw Error('Receipt finalization unavailable');
  }finally{await db.close();}
 }

};
async function freshGrant(token:string,identity:Identity,fetchImpl:typeof fetch):Promise<boolean>{
 const response=await fetchImpl(HUB+'/agent/keys/status',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)return false;
 const state=await response.json() as {identity?:Identity;scopes?:string[];status?:string};
 return state.status==='active'&&state.identity?.issuer===identity.issuer&&state.identity?.subject===identity.subject&&state.scopes?.includes('vision:write')===true&&state.scopes.includes('vision:read');
}
function parseResult(value:unknown):Record<string,any>|null {
 const rpc=value as {result?:{structuredContent?:unknown;content?:Array<{type:string;text?:string}>;isError?:boolean}};
 if(rpc.result?.isError)return null;
 if(rpc.result?.structuredContent&&typeof rpc.result.structuredContent==='object')return rpc.result.structuredContent as Record<string,any>;
 for(const item of rpc.result?.content??[])if(item.type==='text'&&item.text){try{return JSON.parse(item.text);}catch{/*not a receipt*/}}
 return null;
}
export function parseSaveRequest(value:unknown):SaveRequest|null {
 const v=value as SaveRequest;
 if(!v||v.destination!=='vision'||v.visibility!=='private'||!['answer','summary','excerpt','note'].includes(v.kind)||typeof v.title!=='string'||v.title.length>200||typeof v.body!=='string'||!v.body.trim()||v.body.length>64000||typeof v.idempotencyKey!=='string'||!/^[A-Za-z0-9:_-]{8,200}$/.test(v.idempotencyKey)||!Array.isArray(v.sourceRefs)||v.sourceRefs.length<1||v.sourceRefs.length>20)return null;
 if(v.retryOf!==undefined&&(typeof v.retryOf!=='string'||!/^[A-Za-z0-9:_-]{8,200}$/.test(v.retryOf)||v.retryOf===v.idempotencyKey))return null;
 if(v.sourceRefs.some(r=>!r||r.app!=='openchat'||typeof r.conversationId!=='string'||typeof r.messageId!=='string'||(r.sourceDigest!==undefined&&(typeof r.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.sourceDigest)))))return null;
 return {destination:v.destination,kind:v.kind,title:v.title,body:v.body,sourceRefs:v.sourceRefs.map(r=>({app:r.app,conversationId:r.conversationId,messageId:r.messageId,...(r.sourceDigest!==undefined?{sourceDigest:r.sourceDigest}:{})})),visibility:'private',idempotencyKey:v.idempotencyKey,...(v.retryOf!==undefined?{retryOf:v.retryOf}:{})};
}
export async function reviewVisionSave(userId:string,input:SaveRequest,repo:SaveRepository=neoSaveRepository):Promise<SaveReview>{
 const previous=await repo.lookup(userId,input.idempotencyKey);
 if(!recoverable(previous,input))return {status:'rejected',reason:'No eligible rejection with durable proof of non-dispatch, or a new attempt already exists'};
 const sourceRefs:SaveRequest['sourceRefs']=[],sourceContents:string[]=[];
 for(const ref of input.sourceRefs){
  const content=await repo.source(userId,ref.conversationId!,ref.messageId!);
  if(content===null)return {status:'rejected',reason:'Source is unavailable; selection retained'};
  if(input.kind==='excerpt'&&!content.includes(input.body))return {status:'rejected',reason:'Your selection no longer exists in the refreshed source; nothing saved'};
  sourceRefs.push({...ref,sourceDigest:hash(content)});sourceContents.push(content);
 }
 return {status:'ready',sourceRefs,sourceContents};
}
export async function saveToVision(userId:string,input:SaveRequest,repo:SaveRepository=neoSaveRepository,fetchImpl:typeof fetch=fetch):Promise<SaveReceipt>{
 const payloadHash=hash(canonical(input));
 // Receipt history belongs to this authenticated owner even after source deletion or grant revocation.
 const previous=await repo.lookup(userId,input.idempotencyKey);
 if(previous)return (previous.hash===payloadHash||(!input.retryOf&&previous.hash===hash(canonical(input,true))))?historicalReceipt(previous,userId,input.idempotencyKey):{status:'rejected',reason:'Idempotency key reused with different content',...(recoverable(previous,input)?{recoveryAvailable:true}:{})};
 if(input.retryOf){
  if(input.retryOf===input.idempotencyKey||!recoverable(await repo.lookup(userId,input.retryOf),input,input.idempotencyKey))return {status:'rejected',reason:'A new attempt requires a proven rejection before dispatch and unchanged selected content'};
 }
 const identity=await repo.identity(userId);
 if(!identity)return {status:'needs_auth',reason:'Sign in with Ideaflow ID to link your destination'};
 const validateSources=async():Promise<SaveReceipt|null>=>{
  if(!input.sourceRefs.length)return {status:'rejected',reason:'Source references are required'};
  for(const ref of input.sourceRefs){
   if(!ref.sourceDigest||!/^[a-f0-9]{64}$/.test(ref.sourceDigest))return {status:'rejected',reason:'Expected source digest is required for a new save'};
   const content=await repo.source(userId,ref.conversationId!,ref.messageId!);
   if(content===null)return {status:'rejected',reason:'Source is unavailable'};
   if(hash(content)!==ref.sourceDigest)return {status:'rejected',reason:'Source changed; refresh it before saving'};
   if(input.kind==='excerpt'&&!content.includes(input.body))return {status:'rejected',reason:'Selection no longer matches the source'};
  }
  return null;
 };
 const sourceFailure=await validateSources();
 if(sourceFailure)return sourceFailure;
 const token=await repo.token(userId);
 if(!token)return {status:'needs_auth',reason:'Connect Vision and explicitly allow write access'};
 try {if(!await freshGrant(token,identity,fetchImpl))return {status:'needs_auth',reason:'Vision write permission or account linkage is missing or revoked'};}catch{return {status:'unavailable',reason:'Could not check Vision permission; nothing dispatched'};}
 const reservation=await repo.reserve(userId,input.idempotencyKey,payloadHash,selectionHash(input),input.retryOf);
 if(!reservation)return {status:'rejected',reason:'A new attempt already exists or recovery is no longer eligible'};
 if(reservation.hash!==payloadHash)return {status:'rejected',reason:'Idempotency key reused with different content'};
 if(!reservation.fresh)return historicalReceipt(reservation,userId,input.idempotencyKey);
 const dispatchFailure=await validateSources();
 if(dispatchFailure){
  const rejected={...dispatchFailure,recoveryAvailable:true};
  if(!await repo.rejectBeforeDispatch(userId,input.idempotencyKey,reservation.reservationId,rejected))throw Error('Could not prove rejection before dispatch');
  return rejected;
 }
 if(!await repo.beginDispatch(userId,input.idempotencyKey,reservation.reservationId))throw Error('Dispatch ownership unavailable');
 const marker=visionSaveMarker(userId,input.idempotencyKey);
 const refs=input.sourceRefs.map(r=>`https://chat.ideaflow.app/app/chat/${encodeURIComponent(r.conversationId!)}?message=${encodeURIComponent(r.messageId!)}`).join('\n');
 const bodyMd=[input.title?'# '+input.title:'',input.body,refs?'Source:\n'+refs:'',`<!-- ${marker} -->`].filter(Boolean).join('\n\n');
 let receipt:SaveReceipt;
 try{
  const response=await fetchImpl(HUB+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(55000),body:JSON.stringify({jsonrpc:'2.0',id:marker,method:'tools/call',params:{name:'vision__create_note',arguments:{bodyMd,visibility:'private'}}})});
  // Once dispatched, an HTTP failure may hide an upstream successful note. Never replay it.
  const result=response.ok?parseResult(await response.json()):null;
  const note=result?.note;
  if(note&&typeof note.id==='string'&&note.id){receipt={status:'saved',destinationId:note.id,url:typeof result?.url==='string'&&(result.url==='https://vision.ideaflow.app'||result.url.startsWith('https://vision.ideaflow.app/'))?result.url:typeof note.url==='string'&&(note.url==='https://vision.ideaflow.app'||note.url.startsWith('https://vision.ideaflow.app/'))?note.url:'https://vision.ideaflow.app/',savedAt:new Date().toISOString()};}
  else receipt={status:'uncertain',reason:'Vision acknowledgment unknown. Check Vision for '+marker+' before any new save'};
 }catch{receipt={status:'uncertain',reason:'Vision may have saved this. Check Vision for '+marker+'; no automatic resend'};}
 await repo.finish(userId,input.idempotencyKey,receipt,reservation.reservationId);
 return receipt;
}
export async function connectVision(userId:string,fetchImpl:typeof fetch=fetch){
 if(!await neoSaveRepository.identity(userId))return {status:'needs_auth',reason:'Sign in with Ideaflow ID first'};
 const db=getDriver().session();
 try{
  const existing=await db.run('MATCH (g:VisionSaveGrant {userId:$userId}) RETURN g.approvalUrl AS approvalUrl,g.confirmationCode AS confirmationCode,g.expires AS expires',{userId});
  if(existing.records[0]){const row=existing.records[0];const token=await neoSaveRepository.token(userId);if(token&&await freshGrant(token,(await neoSaveRepository.identity(userId))!,fetchImpl))return {status:'connected'};if(Number(row.get('expires'))>Date.now())return {status:'needs_auth',approvalUrl:row.get('approvalUrl'),confirmationCode:row.get('confirmationCode')};}
  const token='ifk_'+randomBytes(32).toString('base64url'),sealed=sealKey(token,userId);
  const response=await fetchImpl(HUB+'/agent/keys/request',{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({name:'OpenChat · Save to Vision',scope:'vision:read vision:write',key_hash:hash(token)})});
  if(!response.ok)return {status:'unavailable',reason:'Vision connection could not be requested'};
  const body=await response.json() as {approval_url:string;confirmation_code:string;expires_in:number};
  if(!body.approval_url.startsWith(HUB+'/agents/approve?')||typeof body.confirmation_code!=='string')return {status:'unavailable'};
  await db.run(`MERGE (g:VisionSaveGrant {userId:$userId}) SET g.ciphertext=$ciphertext,g.iv=$iv,g.approvalUrl=$approvalUrl,g.confirmationCode=$confirmationCode,g.expires=$expires`,{userId,...sealed,approvalUrl:body.approval_url,confirmationCode:body.confirmation_code,expires:Date.now()+Math.min(body.expires_in,1800)*1000});
  return {status:'needs_auth',approvalUrl:body.approval_url,confirmationCode:body.confirmation_code};
 }finally{await db.close();}
}
