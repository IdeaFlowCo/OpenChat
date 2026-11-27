// Manual foreground integration; importing starts nothing and enrolls nobody.
import{DatabaseSync}from'node:sqlite';import{join}from'node:path';import{lstatSync,realpathSync,openSync,closeSync,existsSync}from'node:fs';
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const deny=()=>{throw Object.assign(new Error('write_local_review_required'),{code:'write_local_review_required'});};
function privatePath(p,dir){const s=lstatSync(p);if(realpathSync(p)!==p||s.uid!==process.getuid()||(s.mode&0o077)||(dir?!s.isDirectory():!s.isFile()||s.nlink!==1))deny();}
export class BeeperWriteJournal{
 #db;constructor(directory){privatePath(directory,true);const f=join(directory,'beeper-write-journal.db');if(!existsSync(f)){try{closeSync(openSync(f,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}}privatePath(f,false);this.#db=new DatabaseSync(f);this.#db.exec('PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS active(route TEXT PRIMARY KEY,id TEXT NOT NULL,intent TEXT NOT NULL)');}
 get(route){return this.#db.prepare('SELECT id,intent FROM active WHERE route=?').get(route)||null;}
 remember(route,job){const old=this.get(route);if(old&&(old.id!==job.id||old.intent!==job.intent))deny();this.#db.prepare('INSERT OR IGNORE INTO active VALUES(?,?,?)').run(route,job.id,job.intent);}
 clear(route,id){this.#db.prepare('DELETE FROM active WHERE route=? AND id=?').run(route,id);}
 close(){this.#db.close();}
}
export function createBeeperWriteRunner({connectionId,authority,outbox,adapter,transport,journal,confirm,signal,onStatus=()=>{}}){
 if(!hex(connectionId,48)||typeof confirm!=='function')deny();let busy=false;
 return Object.freeze({runOne:async()=>{
  if(signal?.aborted)return {status:'stopped'};if(busy)return {status:'busy'};busy=true;
  try{
   const prior=journal.get(connectionId),response=await transport.claim(prior?.id),job=response?.job;
   if(!job){if(prior)deny();return {status:'idle'};}
   if(!hex(job.id,48)||!hex(job.leaseId,48)||typeof job.intent!=='string'||job.intent.length>150000||Object.keys(job).some(k=>!['id','intent','leaseId','leaseUntil'].includes(k)))deny();
   const envelope={connectionId,operationId:job.id,opaqueIntent:job.intent};
   const scope=authority.verify(envelope);journal.remember(connectionId,job);
   if(signal?.aborted)return {status:'stopped'};
   if(!outbox.has(job.id)||outbox.status(job.id).state==='review'){
    if(outbox.has(job.id)&&scope.until<=Date.now())outbox.expireUnattempted(job.id);
    else await outbox.authorize(envelope,summary=>signal?.aborted?false:confirm(summary));
   }
   outbox.expireUnattempted(job.id);
   let state=await outbox.dispatch(job.id,adapter);
   if(state.state==='pending'){try{state=await outbox.reconcile(job.id,adapter);}catch{/* Keep pending accurate; never infer failure or resend from a GET error. */}}
   const receipt=authority.statusReceipt(connectionId,job.id,state.state);
   const ack=await transport.receipt({operationId:job.id,leaseId:job.leaseId,...receipt},start=>authority.beforeStatusDisclosure(connectionId,job.id,receipt,start));
   if(!ack?.accepted||ack.revision!==receipt.revision)deny();
   onStatus(state.state);
   if(receipt.terminal){journal.clear(connectionId,job.id);return {status:'complete',state:state.state,operationId:job.id};}
   return {status:state.state==='unknown'?'blocked':'pending',state:state.state,operationId:job.id};
  }catch(error){if(signal?.aborted)return {status:'stopped'};const code=['write_authorization_required','write_transport_unavailable','write_transport_conflict','write_transport_invalid'].includes(error?.code)?error.code:'write_local_review_required';onStatus(code);return {status:'blocked',reason:code};}
  finally{busy=false;}
 }});
}
