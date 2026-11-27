#!/usr/bin/env node
// Manual, source-only WRITE entry point. No automatic enrollment/service/start.
import{resolve,join}from'node:path';import{homedir}from'node:os';import{fileURLToPath}from'node:url';import{mkdirSync,lstatSync,realpathSync,writeFileSync,readFileSync}from'node:fs';import{createInterface}from'node:readline/promises';import{setTimeout as delay}from'node:timers/promises';
import{BeeperForegroundLease,localKeychainToken}from'./foreground.mjs';import{confirmBeeperLocally}from'./readAuthority.mjs';import{createBeeperReadonlyClient}from'./desktopApi.mjs';import{BeeperWriteAuthority}from'./writeAuthority.mjs';import{BeeperPinnedSendOutbox}from'./sendOutbox.mjs';import{createBeeperWriteClient}from'./writeDesktopApi.mjs';import{createBeeperWriteRelay}from'./writeRelayTransport.mjs';import{BeeperWriteJournal,createBeeperWriteRunner}from'./writeRunner.mjs';
const id=v=>typeof v==='string'&&/^[a-f0-9]{48}$/.test(v),deny=()=>{throw Error('local_write_configuration_required');};
function privatePath(p,dir){const s=lstatSync(p);if(realpathSync(p)!==p||s.uid!==process.getuid()||(s.mode&0o077)||(dir?!s.isDirectory():!s.isFile()||s.nlink!==1))deny();}
const allowed=new Set(['directory','pairing-directory','pair-route','owner','account','chat','read-service','read-account','write-service','write-account','connection']);
function args(argv){const[command,...rest]=argv,o={};for(let i=0;i<rest.length;i+=2){const k=rest[i]?.slice(2);if(!rest[i]?.startsWith('--')||!allowed.has(k)||!rest[i+1]||Object.hasOwn(o,k))deny();o[k]=rest[i+1];}return{command,o};}
async function confirmSend(summary,abort){
 if(!process.stdin.isTTY||!process.stdout.isTTY||abort.signal.aborted)return false;
 const io=createInterface({input:process.stdin,output:process.stdout});io.on('SIGINT',()=>abort.abort());
 const safe=JSON.stringify(summary).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 try{return(await io.question(safe+'\nType send to send THIS reply to THIS chat: ',{signal:abort.signal}))==='send';}finally{io.close();}
}
export async function main(argv=process.argv.slice(2)){
 process.umask(0o077);const{command,o}=args(argv);
 if(!['setup','run','revoke'].includes(command))throw Error('Use setup, run or revoke; see docs/beeper-replies.md.');
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('local_interactive_terminal_required');
 const directory=resolve(o.directory||join(homedir(),'.config','openchat-beeper-write')),paired=resolve(o['pairing-directory']||join(homedir(),'.paseo','openchat-machine'));
 mkdirSync(directory,{recursive:true,mode:0o700});privatePath(directory,true);privatePath(paired,true);
 const lease=command==='revoke'?null:new BeeperForegroundLease(directory),abort=new AbortController(),stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let authority,outbox,journal;
 try{
  authority=new BeeperWriteAuthority({directory,pairingDirectory:paired});
  if(command==='revoke'){if(!id(o.connection)||!authority.revoke(o.connection))deny();console.log('Local write grant revoked. No later send/status dispatch is authorized. An already started provider send cannot be recalled.');return;}
  if(command==='setup'){
   if(!id(o['pair-route'])||!o.owner||!o.account||!o.chat)deny();
   const readKeychain={service:o['read-service'],account:o['read-account']},writeKeychain={service:o['write-service'],account:o['write-account']};localKeychainToken(writeKeychain);
   if(!await confirmBeeperLocally({operation:'Read metadata for selected reply target',account:o.account,chat:o.chat,disclosure:'Local terminal only'}))return;
   const source=createBeeperReadonlyClient({readToken:localKeychainToken(readKeychain),signal:abort.signal}),chat=await source.chat(o.account,o.chat);if(abort.signal.aborted)return;
   const approved=await authority.approveWrite({pairRoute:o['pair-route'],ownerId:o.owner,accountId:o.account,chatMetadata:chat,expiresAt:Date.now()+3600000,destination:'https://chat.ideaflow.app'},confirmBeeperLocally);if(abort.signal.aborted){authority.revoke(approved.publicOffer.connectionId);return;}
   const configuration={version:1,connectionId:approved.publicOffer.connectionId,keychain:writeKeychain,relayToken:approved.relayToken,machineKey:approved.publicOffer.machineKey};
   writeFileSync(join(directory,configuration.connectionId+'.json'),JSON.stringify(configuration),{flag:'wx',mode:0o600});
   console.log('Import this encrypted write grant in the paired native app. No source token/private key is printed:');console.log(approved.wire);console.log('Local connection ID: '+configuration.connectionId);return;
  }
  if(!id(o.connection))deny();const file=join(directory,o.connection+'.json');privatePath(file,false);if(lstatSync(file).size>8192)deny();const c=JSON.parse(readFileSync(file,'utf8'));
  if(c.version!==1||c.connectionId!==o.connection||!/^ocbs_[A-Za-z0-9_-]{43}$/.test(c.relayToken)||!/^[a-f0-9]{64}$/.test(c.machineKey))deny();
  if(!await confirmBeeperLocally({operation:'Start manual reply worker',connectionId:o.connection,scope:'This selected chat only; each reply requires typing send locally; Ctrl-C stops',disclosure:'Encrypted status to https://chat.ideaflow.app'}))return;
  outbox=new BeeperPinnedSendOutbox({directory,machineKey:c.machineKey,verifier:authority});journal=new BeeperWriteJournal(directory);
  const transport=createBeeperWriteRelay({readToken:async()=>c.relayToken,signal:abort.signal}),adapter=createBeeperWriteClient({readWriteToken:localKeychainToken(c.keychain),signal:abort.signal});
  const runner=createBeeperWriteRunner({connectionId:o.connection,authority,outbox,adapter,transport,journal,confirm:summary=>confirmSend(summary,abort),signal:abort.signal,onStatus:s=>console.log(s)});
  while(!abort.signal.aborted){const result=await runner.runOne();if(result.status==='blocked'||result.status==='stopped')break;try{await delay(3000,undefined,{signal:abort.signal});}catch{if(!abort.signal.aborted)throw Error('write_stopped');}}
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);journal?.close();outbox?.close();authority?.close();lease?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Reply worker stopped. Review local pairing/grant/Keychain and unresolved operation status. No private error details were logged, and an uncertain reply must not be resent through another Mac.');process.exitCode=1;});
