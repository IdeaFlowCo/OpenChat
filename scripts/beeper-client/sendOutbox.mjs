// Reply milestone kernel only. No runtime/CLI route enables it. A separately
// reviewed typed write verifier is REQUIRED; read grants cannot authorize sends.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {lstatSync,realpathSync,existsSync,openSync,closeSync} from 'node:fs';
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const deny=()=>{throw Object.assign(new Error('write_approval_required'),{code:'write_approval_required'});};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const safeId=v=>typeof v==='string'&&v.length>0&&v.length<=2000&&!/[\u0000-\u001f\u007f]/u.test(v);
function pathPrivate(path,directory){const s=lstatSync(path);if(realpathSync(path)!==path||s.uid!==process.getuid()||(s.mode&0o077)||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))deny();}
function checked(v,machine,now){
 const fields=['protocol','audience','ownerId','route','machineKey','deviceKey','accountKey','chatKey','grantId','operationId','sequence','until','text','replyToMessageId','accountId','chatId','title','network'];
 if(!v||Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k))||v.protocol!=='openchat.beeper.send.v1'||v.audience!=='beeper.send'||v.machineKey!==machine
  ||!safeId(v.ownerId)||!hex(v.route,48)||!hex(v.deviceKey,64)||!hex(v.accountKey,64)||!hex(v.chatKey,64)||!hex(v.grantId,48)||!hex(v.operationId,48)
  ||!Number.isSafeInteger(v.sequence)||v.sequence<1||!Number.isSafeInteger(v.until)||v.until<=now||v.until>now+300000
  ||typeof v.text!=='string'||!v.text.trim()||Buffer.byteLength(v.text,'utf8')>16000||v.replyToMessageId!==null&&!safeId(v.replyToMessageId)||!safeId(v.accountId)||!safeId(v.chatId)||!safeId(v.title)||v.network!=='whatsapp')deny();
 return JSON.parse(JSON.stringify(v));
}
/** verifier.verify(frame) must cryptographically authenticate the device and
 * derive source IDs from an immutable Mac-local WRITE grant, never relay input.
 * verifier.admit(scope,start) synchronously rechecks revocation under its local
 * authority fence and initiates start there. There is deliberately no default. */
export class BeeperPinnedSendOutbox{
 #db;#verifier;#machine;#now;
 constructor({directory,machineKey,verifier,clock=Date.now}){
  if(!hex(machineKey,64)||typeof verifier?.verify!=='function'||typeof verifier?.admit!=='function'||typeof verifier?.admitStatus!=='function')deny();
  pathPrivate(directory,true);const file=join(directory,'beeper-send-outbox.db');
  if(!existsSync(file)){try{closeSync(openSync(file,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}}
  pathPrivate(file,false);this.#db=new DatabaseSync(file);this.#db.exec(`PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;
   CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY,grantId TEXT NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,pending TEXT,final TEXT);
   CREATE TABLE IF NOT EXISTS highwater(grantId TEXT PRIMARY KEY,seq INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS machine(id INTEGER PRIMARY KEY,pub TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS one_write_review ON sends(grantId) WHERE state IN ('review','approved','attempted','pending','unknown');`);
  const stored=this.#db.prepare('SELECT pub FROM machine WHERE id=1').get();
  if(stored&&stored.pub!==machineKey){this.#db.close();deny();}
  if(!stored)this.#db.prepare('INSERT INTO machine VALUES(1,?)').run(machineKey);
  this.#verifier=verifier;this.#machine=machineKey;this.#now=clock;
  // A process died after its durable attempt marker. There is no safe resend.
  this.#db.exec("UPDATE sends SET state='unknown' WHERE state='attempted'");
 }
 #tx(f){this.#db.exec('BEGIN IMMEDIATE');try{const v=f();this.#db.exec('COMMIT');return v;}catch(e){this.#db.exec('ROLLBACK');throw e;}}
 #row(id){if(!hex(id,48))deny();const r=this.#db.prepare('SELECT * FROM sends WHERE id=?').get(id);if(!r)deny();const scope=JSON.parse(r.scope);if(scope.machineKey!==this.#machine)deny();return {...r,scope};}
 #admit(scope,start){let admitted=false,open=true,result;try{result=this.#verifier.admit(Object.freeze(scope),()=>{if(!open||admitted)deny();admitted=true;return start();});}finally{open=false;}if(!admitted){void Promise.resolve(result).catch(()=>{});deny();}return result;}
 has(id){if(!hex(id,48))deny();return !!this.#db.prepare('SELECT id FROM sends WHERE id=?').get(id);}
 expireUnattempted(id){this.#tx(()=>{const r=this.#row(id);if(['review','approved'].includes(r.state)&&r.scope.until<=this.#now())this.#db.prepare("UPDATE sends SET state='cancelled' WHERE id=?").run(id);});return this.status(id);}
 /** Returns public local status only, never the message body/source IDs. */
 status(id){const r=this.#row(id);return {operationId:id,state:r.state,machineKey:this.#machine,pendingMessageId:r.pending,finalMessageId:r.final};}
 async authorize(frame,confirm){
  if(typeof confirm!=='function')deny();const scope=checked(await this.#verifier.verify(frame),this.#machine,this.#now()),hash=digest(scope);
  const first=this.#tx(()=>{
   const old=this.#db.prepare('SELECT hash,state FROM sends WHERE id=?').get(scope.operationId);
   if(old){if(old.hash!==hash)deny();return old.state==='review';}
   const high=this.#db.prepare('SELECT seq FROM highwater WHERE grantId=?').get(scope.grantId);if(high&&high.seq>=scope.sequence)deny();
   return this.#admit(scope,()=>{
    this.#db.prepare("INSERT INTO sends(id,grantId,seq,hash,scope,state) VALUES(?,?,?,?,?,'review')").run(scope.operationId,scope.grantId,scope.sequence,hash,JSON.stringify(scope));
    this.#db.prepare('INSERT INTO highwater VALUES(?,?) ON CONFLICT(grantId) DO UPDATE SET seq=excluded.seq').run(scope.grantId,scope.sequence);return true;
   });
  });
  if(!first)return this.status(scope.operationId);
  let yes=false;try{yes=await confirm(Object.freeze({operationId:scope.operationId,title:scope.title,text:scope.text,replyToMessageId:scope.replyToMessageId,machineKey:scope.machineKey,deviceKey:scope.deviceKey,network:scope.network,destination:'selected source chat',until:scope.until}));}catch{/* Cancellation preserves the spent operation. */}
  this.#tx(()=>{const row=this.#row(scope.operationId);if(row.hash!==hash||row.state!=='review')deny();
   if(!yes||scope.until<=this.#now()){this.#db.prepare("UPDATE sends SET state='cancelled' WHERE id=?").run(scope.operationId);return;}
   this.#admit(scope,()=>this.#db.prepare("UPDATE sends SET state='approved' WHERE id=?").run(scope.operationId));
  });return this.status(scope.operationId);
 }
 async dispatch(id,adapter){
  const scope=this.#tx(()=>{const r=this.#row(id);if(r.state!=='approved')return null;
   if(r.scope.until<=this.#now())deny();
   // Durable fence BEFORE token lookup/provider POST; no adapter retry option.
   return this.#admit(r.scope,()=>{this.#db.prepare("UPDATE sends SET state='attempted' WHERE id=?").run(id);return r.scope;});
  });
  if(!scope)return this.status(id);
  try{
   const result=await adapter.send(scope.accountId,scope.chatId,{text:scope.text,replyToMessageId:scope.replyToMessageId,beforeFetch:start=>this.#admit(scope,()=>{if(scope.until<=this.#now())deny();return start();})});
   if(!result||result.chatID!==scope.chatId||!safeId(result.pendingMessageID))throw Error('unknown_provider_result');
   this.#tx(()=>this.#db.prepare("UPDATE sends SET state='pending',pending=? WHERE id=? AND state='attempted'").run(result.pendingMessageID,id));
  }catch{this.#tx(()=>this.#db.prepare("UPDATE sends SET state='unknown' WHERE id=? AND state='attempted'").run(id));}
  return this.status(id);
 }
 async reconcile(id,adapter){
  const row=this.#row(id);if(!['pending','unknown'].includes(row.state)||!row.pending)return this.status(id);
  // Same locally pinned Mac and provider ID only. Never resend or search by text.
  const result=await adapter.retrieve(row.scope.accountId,row.scope.chatId,row.pending,{beforeFetch:start=>this.#verifier.admitStatus(Object.freeze(row.scope),start)});
  if(!result||result.accountID!==row.scope.accountId||result.chatID!==row.scope.chatId||result.isSender!==true||!safeId(result.id))deny();
  const state=result.sendStatus?.status==='SUCCESS'?'confirmed':result.sendStatus?.status==='FAIL_PERMANENT'?'failed':'pending';
  this.#tx(()=>this.#db.prepare('UPDATE sends SET state=?,final=? WHERE id=? AND pending=? AND state IN (\'pending\',\'unknown\')').run(state,state==='confirmed'?result.id:null,id,row.pending));
  return this.status(id);
 }
 cancel(id){this.#tx(()=>{const r=this.#row(id);if(!['review','approved'].includes(r.state))deny();this.#db.prepare("UPDATE sends SET state='cancelled' WHERE id=?").run(id);});}
 close(){this.#db.close();}
}
