import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getDriver } from '../db.js';

export const ID_ISSUER = 'https://id.ideaflow.app/api/auth';
const HUB = 'https://id.ideaflow.app';
export type SaveStatus = 'saved'|'rejected'|'needs_auth'|'unavailable'|'uncertain';
export type SaveReceipt = {status:SaveStatus;destinationId?:string;url?:string;savedAt?:string;reason?:string};
export type SaveRequest = {destination:'vision';kind:'answer'|'summary'|'excerpt'|'note';title:string;body:string;sourceRefs:Array<{app:string;conversationId?:string;messageId?:string}>;visibility:'private';idempotencyKey:string};
export type Identity = {issuer:string;subject:string};
export interface SaveRepository {
 identity(userId:string):Promise<Identity|null>;
 source(userId:string,conversationId:string,messageId:string):Promise<string|null>;
 lookup(userId:string,key:string):Promise<{hash:string;receipt:SaveReceipt}|null>;
 reserve(userId:string,key:string,hash:string):Promise<{fresh:boolean;hash:string;receipt:SaveReceipt}>;
 finish(userId:string,key:string,receipt:SaveReceipt):Promise<void>;
 token(userId:string):Promise<string|null>;
}
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const visionSaveMarker=(userId:string,key:string)=>'openchat-save:'+hash(JSON.stringify([userId,key]));
function searchableReceipt(receipt:SaveReceipt,userId:string,key:string):SaveReceipt {
 if(receipt.status!=='uncertain')return receipt;
 const marker=visionSaveMarker(userId,key);
 return {...receipt,reason:receipt.reason?.includes(marker)?receipt.reason:(receipt.reason??'Save acknowledgment unknown')+'; check Vision for '+marker};
}
function canonical(input:SaveRequest):string { return JSON.stringify([input.destination,input.kind,input.title,input.body,input.sourceRefs.map(r=>[r.app,r.conversationId??null,r.messageId??null]),input.visibility]); }
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
 async lookup(userId,key){const db=getDriver().session();try{const r=await db.run('MATCH (s:VisionSaveReceipt {key:$key,userId:$userId}) RETURN s.hash AS hash,s.receipt AS receipt',{userId,key:JSON.stringify([userId,key])});const row=r.records[0];return row?{hash:row.get('hash'),receipt:JSON.parse(row.get('receipt'))}:null;}finally{await db.close();}},
 async reserve(userId,key,payloadHash){const db=getDriver().session();const reservation=randomBytes(16).toString('hex');try{const r=await db.run(`MERGE (s:VisionSaveReceipt {key:$key}) ON CREATE SET s.userId=$userId,s.hash=$payloadHash,s.reservation=$reservation,s.receipt=$initial RETURN s.hash AS hash,s.reservation AS reservation,s.receipt AS receipt`,{userId,key:JSON.stringify([userId,key]),payloadHash,reservation,initial:JSON.stringify({status:'uncertain',reason:'Save dispatch committed; acknowledgment not yet known'})});const row=r.records[0];return {fresh:row.get('reservation')===reservation,hash:row.get('hash'),receipt:JSON.parse(row.get('receipt'))};}finally{await db.close();}},
 async finish(userId,key,receipt){const db=getDriver().session();try{await db.run('MATCH (s:VisionSaveReceipt {key:$key,userId:$userId}) SET s.receipt=$receipt',{userId,key:JSON.stringify([userId,key]),receipt:JSON.stringify(receipt)});}finally{await db.close();}}
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
 if(v.sourceRefs.some(r=>!r||r.app!=='openchat'||typeof r.conversationId!=='string'||typeof r.messageId!=='string'))return null;
 return {destination:v.destination,kind:v.kind,title:v.title,body:v.body,sourceRefs:v.sourceRefs.map(r=>({app:r.app,conversationId:r.conversationId,messageId:r.messageId})),visibility:'private',idempotencyKey:v.idempotencyKey};
}
export async function saveToVision(userId:string,input:SaveRequest,repo:SaveRepository=neoSaveRepository,fetchImpl:typeof fetch=fetch):Promise<SaveReceipt>{
 const payloadHash=hash(canonical(input));
 // Receipt history belongs to this authenticated owner even after source deletion or grant revocation.
 const previous=await repo.lookup(userId,input.idempotencyKey);
 if(previous)return previous.hash===payloadHash?searchableReceipt(previous.receipt,userId,input.idempotencyKey):{status:'rejected',reason:'Idempotency key reused with different content'};
 const identity=await repo.identity(userId);
 if(!identity)return {status:'needs_auth',reason:'Sign in with Ideaflow ID to link your destination'};
 for(const ref of input.sourceRefs){const content=await repo.source(userId,ref.conversationId!,ref.messageId!);if(content===null)return {status:'rejected',reason:'Source is unavailable'};if(input.kind==='excerpt'&&!content.includes(input.body))return {status:'rejected',reason:'Selection no longer matches the source'};}
 const token=await repo.token(userId);
 if(!token)return {status:'needs_auth',reason:'Connect Vision and explicitly allow write access'};
 try {if(!await freshGrant(token,identity,fetchImpl))return {status:'needs_auth',reason:'Vision write permission or account linkage is missing or revoked'};}catch{return {status:'unavailable',reason:'Could not check Vision permission; nothing dispatched'};}
 const reservation=await repo.reserve(userId,input.idempotencyKey,payloadHash);
 if(reservation.hash!==payloadHash)return {status:'rejected',reason:'Idempotency key reused with different content'};
 if(!reservation.fresh)return searchableReceipt(reservation.receipt,userId,input.idempotencyKey);
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
 await repo.finish(userId,input.idempotencyKey,receipt);
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
