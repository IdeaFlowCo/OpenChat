// Explicitly invoked foreground work only. Importing this module starts nothing.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BeeperRelayTransportError,beeperBatchDigest} from './relayTransport.mjs';
const localError=()=>Object.assign(new Error('Local source reconciliation is required'),{code:'source_reconciliation_required'});
const hex=(value,length)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function privatePath(path,directory){
 const s=lstatSync(path);if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||directory!==s.isDirectory())throw localError();
}
/** The journal contains authenticated opaque tickets and relay claims, never
 * source credentials or message bodies. It is separate from the authority spool. */
export class BeeperForegroundJournal{
 #db;
 constructor(directory){
  privatePath(directory,true);const file=join(directory,'beeper-foreground.db');
  if(!existsSync(file)){try{closeSync(openSync(file,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}}
  privatePath(file,false);this.#db=new DatabaseSync(file);this.#db.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS pending(route TEXT PRIMARY KEY,job TEXT NOT NULL,claim TEXT NOT NULL,ticket TEXT NOT NULL)');
 }
 get(route){const row=this.#db.prepare('SELECT claim,ticket FROM pending WHERE route=?').get(route);return row?{claim:JSON.parse(row.claim),ticket:JSON.parse(row.ticket)}:null;}
 put(route,claim,ticket){
  const encoded=JSON.stringify({claim,ticket});if(!hex(route,48)||encoded.length>65536||claim.id!==ticket.jobId)throw localError();
  this.#db.prepare('INSERT INTO pending(route,job,claim,ticket) VALUES(?,?,?,?) ON CONFLICT(route) DO UPDATE SET claim=excluded.claim,ticket=excluded.ticket WHERE pending.job=excluded.job').run(route,claim.id,JSON.stringify(claim),JSON.stringify(ticket));
  if(this.get(route)?.claim.id!==claim.id)throw localError();
 }
 clear(route,job){this.#db.prepare('DELETE FROM pending WHERE route=? AND job=?').run(route,job);}
 close(){this.#db.close();}
}
const stableFailures=new Set(['source_authorization_required','source_unavailable','source_incompatible','source_reconciliation_required','local_approval_required']);
/** The actual token callback and connectionId are locally selected together.
 * Authority alone authenticates the request and supplies the selected source. */
export function createBeeperForegroundRunner({connectionId,transport,authority,adapter,journal,signal,onStatus=()=>{}}){
 if(!hex(connectionId,48))throw localError();
 let running=false;
 const guardedAdapter={messages:(account,chat,options)=>adapter.messages(account,chat,{...options,beforeFetch:start=>{if(signal?.aborted)throw new BeeperRelayTransportError('relay_stopped');return options.beforeFetch(()=>{if(signal?.aborted)throw new BeeperRelayTransportError('relay_stopped');return start();});}})};
 return Object.freeze({runOne:async()=>{
  if(signal?.aborted)return {status:'stopped'};if(running)return {status:'busy'};running=true;let claim,ticket,phase='claiming';
  try{
   const pending=journal.get(connectionId);
   if(pending){
    ticket=pending.ticket;phase='resuming';
    const recovered=await transport.resume(pending.claim.id);claim=recovered.job;
    if(!claim||claim.id!==pending.claim.id||claim.epoch!==pending.claim.epoch||claim.kind!==pending.claim.kind||claim.accountKey!==pending.claim.accountKey||claim.chatKey!==pending.claim.chatKey||claim.intent!==pending.claim.intent)throw localError();
   }else claim=(await transport.claim()).job;
   if(!claim){onStatus('idle');return {status:'idle'};}
   if(!hex(claim.id,48)||!hex(claim.leaseId,48)||Object.hasOwn(claim,'connectionId'))throw localError();
   ticket=authority.prepare({...claim,connectionId});
   if(pending&&(ticket.jobId!==pending.ticket.jobId||ticket.requestId!==pending.ticket.requestId||ticket.grantId!==pending.ticket.grantId))throw localError();
   journal.put(connectionId,claim,ticket); // Durable BEFORE a source GET or upload.
   onStatus('reading');phase='reading';await authority.read(ticket,guardedAdapter);
   for(let count=0;count<21;count++){
    const batch=authority.nextPending(ticket);
    if(!batch){journal.clear(connectionId,claim.id);onStatus('complete');return {status:'complete',jobId:claim.id};}
    if(count===20||!Number.isSafeInteger(batch.sequence)||batch.sequence<0||batch.digest!==beeperBatchDigest(batch.payload,batch.final))throw localError();
    const wire=JSON.parse(JSON.stringify({jobId:claim.id,leaseId:claim.leaseId,...batch}));
    phase='uploading';
    const ack=await transport.deliver(wire,start=>authority.beforeDisclosure(ticket,batch.sequence,verified=>{
      if(verified.sequence!==batch.sequence||verified.digest!==batch.digest||verified.final!==batch.final)throw localError();
      return start();
    }));
    if(!ack||ack.sequence!==batch.sequence)throw localError();
    authority.acknowledge(ticket,{sequence:batch.sequence,digest:batch.digest,chatId:ack.chatId});
    onStatus(batch.final?'confirmed':'partial');
   }
   throw localError();
  }catch(error){
   if(signal?.aborted){onStatus('stopped');return {status:'stopped'};}
   if(error instanceof BeeperRelayTransportError){
    if(error.code==='relay_stopped'){onStatus('stopped');return {status:'stopped'};}
    if(error.code==='relay_authorization_required'){onStatus(error.code);return {status:'blocked',reason:error.code};}
    const terminal=error.code==='relay_rejected'&&((phase==='resuming'&&[404,409].includes(error.status))||(error.serverCode&&error.serverCode!=='lease_or_sequence_not_current'));
    if(!terminal){onStatus(error.code);return {status:'retry',reason:error.code};}
   }
   const code=stableFailures.has(error?.code)?error.code:error?.code==='authorization_required'?'source_authorization_required':error?.code==='unavailable'?'source_unavailable':error?.code==='incompatible'?'source_incompatible':'source_reconciliation_required';
   if(claim&&hex(claim.id,48)&&hex(claim.leaseId,48)){
    try{await transport.fail({jobId:claim.id,leaseId:claim.leaseId,code});}catch{/* Keep the local failure honest even when the relay is unavailable. */}
    if(ticket){try{authority.abandon(ticket);}catch{/* A revoked/expired local grant stays denied. */}}
    journal.clear(connectionId,claim.id);
   }
   onStatus(code);return {status:'blocked',reason:code};
  }finally{running=false;}
 }});
}
export async function runBeeperForeground({runner,signal,intervalMs=5000}){
 if(!Number.isFinite(intervalMs)||intervalMs<1000||intervalMs>30000)throw localError();
 while(!signal.aborted){const result=await runner.runOne();if(result.status==='blocked'||result.status==='stopped')return result;try{await delay(intervalMs,undefined,{signal});}catch{if(!signal.aborted)throw localError();}}
}
