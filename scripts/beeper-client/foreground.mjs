#!/usr/bin/env node
// Manual, foreground Mac entry point. No daemon, boot hook or implicit enrollment.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,realpathSync,openSync,closeSync} from 'node:fs';
import {BeeperReadAuthority,confirmBeeperLocally} from './readAuthority.mjs';
import {createBeeperReadonlyClient} from './desktopApi.mjs';
import {createBeeperRelayTransport} from './relayTransport.mjs';
import {BeeperForegroundJournal,createBeeperForegroundRunner,runBeeperForeground} from './foregroundRunner.mjs';
const runFile=promisify(execFile),id=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
const failure=()=>{throw new Error('local_configuration_required');};
function privatePath(path,directory){const s=lstatSync(path);if(realpathSync(path)!==path||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1&&!directory||(directory?!s.isDirectory():!s.isFile()))failure();}
export class BeeperForegroundLease{
 #db;
 constructor(directory){
  privatePath(directory,true);const file=join(directory,'beeper-process.db');
  if(!existsSync(file)){try{closeSync(openSync(file,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}}
  privatePath(file,false);this.#db=new DatabaseSync(file);
  try{this.#db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{this.#db.close();throw new Error('foreground_already_running');}
 }
 close(){this.#db.exec('ROLLBACK');this.#db.close();}
}
export function localKeychainToken({service,account},invoke=runFile){
 if(![service,account].every(v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/u.test(v)))failure();
 return async()=>{
  if(process.platform!=='darwin')throw new Error('mac_source_required');
  try{const {stdout}=await invoke('/usr/bin/security',['find-generic-password','-w','-s',service,'-a',account],{timeout:10000,maxBuffer:8192,encoding:'utf8'});const token=stdout.replace(/[\r\n]+$/u,'');if(!token||/[\r\n]/u.test(token))failure();return token;}
  catch{throw Object.assign(new Error('source_authorization_required'),{code:'authorization_required'});}
 };
}
function options(argv){
 const [command,...rest]=argv,allowed=new Set(['directory','pairing-directory','connection','pair-route','owner','account','keychain-service','keychain-account','chat','grant','network']);
 const args={};for(let i=0;i<rest.length;i+=2){const key=rest[i]?.slice(2);if(!rest[i]?.startsWith('--')||!allowed.has(key)||!rest[i+1]||Object.hasOwn(args,key))failure();args[key]=rest[i+1];}
 return {command,args};
}
export async function main(argv=process.argv.slice(2)){
 process.umask(0o077);const {command,args}=options(argv);
 if(!['setup','catalogue','approve-chat','run','revoke'].includes(command))throw new Error('Use setup, catalogue, approve-chat, run or revoke; see docs/beeper-client-operations.md.');
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('local_interactive_terminal_required');
 const directory=resolve(args.directory||join(homedir(),'.config','openchat-beeper'));
 mkdirSync(directory,{recursive:true,mode:0o700});privatePath(directory,true);
 const pairingDirectory=resolve(args['pairing-directory']||join(homedir(),'.paseo','openchat-machine'));
 privatePath(pairingDirectory,true);
 const lock=command==='revoke'?undefined:new BeeperForegroundLease(directory);
 let journal,authority;
 try{
  authority=new BeeperReadAuthority({directory,pairingDirectory});
  if(command==='revoke'){
   if(!id(args.grant))failure();authority.revoke(args.grant);console.log('Local grant revoked. Future reads and uploads are denied; already imported copies remain.');return;
  }
  let config,connectionId=args.connection;
  if(command==='setup'){
   if(!id(args['pair-route'])||!args.owner||!args.account)failure();
   const keychain={service:args['keychain-service'],account:args['keychain-account']};localKeychainToken(keychain);
   const approved=await authority.approveCatalogue({pairRoute:args['pair-route'],ownerId:args.owner,accountId:args.account,network:args.network||'whatsapp',expiresAt:Date.now()+3600000,destination:'https://chat.ideaflow.app'},confirmBeeperLocally);
   connectionId=approved.publicOffer.connectionId;
   config={version:1,connectionId,pairRoute:args['pair-route'],accountId:args.account,keychain,relayToken:approved.relayToken};
   const file=join(directory,connectionId+'.json');writeFileSync(file,JSON.stringify(config),{flag:'wx',mode:0o600});
   console.log('Public offer for the paired OpenChat account (no token/private key):');console.log(JSON.stringify(approved.publicOffer));return;
  }
  if(!id(connectionId))failure();const file=join(directory,connectionId+'.json');privatePath(file,false);
  const stat=lstatSync(file);if(stat.size>8192)failure();config=JSON.parse(readFileSync(file,'utf8'));
  if(config.version!==1||config.connectionId!==connectionId||!id(config.pairRoute)||typeof config.accountId!=='string'||!/^ocbr_[A-Za-z0-9_-]{43}$/.test(config.relayToken))failure();
  const abort=new AbortController(),stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
   const adapter=createBeeperReadonlyClient({readToken:localKeychainToken(config.keychain),signal:abort.signal}),transport=createBeeperRelayTransport({readToken:async()=>config.relayToken,signal:abort.signal});
   if(command==='approve-chat'){
    if(!args.chat)failure();
    // This metadata GET is local only; its account is fixed by local setup.
    if(!await confirmBeeperLocally({operation:'Read metadata for the locally selected chat',accountId:config.accountId,chatId:args.chat,disclosure:'Mac terminal only'}))return;
    const chat=await adapter.chat(config.accountId,args.chat),offer=await authority.approveChat(connectionId,chat,confirmBeeperLocally);
    console.log('Encrypted grant for your paired device:');console.log(offer.wire);console.log('Local revoke ID: '+offer.grantId);return;
   }
   if(!await confirmBeeperLocally({operation:command==='catalogue'?'Publish one bounded chat catalogue page':'Start foreground selected-chat reads',connectionId,destination:'https://chat.ideaflow.app',disclosure:command==='catalogue'?'Chat titles, types and activity times from the locally approved network/account':'Only separately approved chat messages and participant attribution; Ctrl-C stops'}))return;
   if(command==='catalogue'){
    const result=await authority.readCatalogue(connectionId,adapter,(body,beforeFetch)=>transport.publishCatalogue(body,beforeFetch));console.log(result.count?'One catalogue page published. It may be partial.':'Mac reported no supported chats for this approved network/account on this page. The catalogue may be partial.');return;
   }
   journal=new BeeperForegroundJournal(directory);
   const runner=createBeeperForegroundRunner({connectionId,transport,authority,adapter,journal,signal:abort.signal,onStatus:status=>console.log(status)});
   await runBeeperForeground({runner,signal:abort.signal});
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }finally{journal?.close();authority?.close();lock?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Beeper foreground stopped. Check local pairing, approval, Keychain entry and source availability; no private error details were logged.');process.exitCode=1;});
