import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {BeeperForegroundJournal,createBeeperForegroundRunner,runBeeperForeground} from '../../../scripts/beeper-client/foregroundRunner.mjs';
import {createBeeperRelayTransport,beeperBatchDigest} from '../../../scripts/beeper-client/relayTransport.mjs';
import {createBeeperReadonlyClient} from '../../../scripts/beeper-client/desktopApi.mjs';
const roots:string[]=[];const response=(value:unknown,status=200)=>Response.json(value,{status});
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'beeper-runner-'));roots.push(directory);
 const route='1'.repeat(48),job={id:'2'.repeat(48),leaseId:'3'.repeat(48),epoch:1,kind:'open',nextSequence:0,intent:'opaque-test-intent',accountKey:'4'.repeat(64),chatKey:'5'.repeat(64)};
 const payload={source:{accountKey:job.accountKey,chatKey:job.chatKey},coverage:{complete:false},messages:[{text:'Synthetic cached page'}]};
 const batch={sequence:0,final:true,payload,digest:beeperBatchDigest(payload,true)},ticket={jobId:job.id,grantId:'6'.repeat(48),requestId:'7'.repeat(32)};
 let staged=false,confirmed=false,revoked=false;
 const authority={
  prepare:vi.fn((claim:any)=>{expect(claim.connectionId).toBe(route);return ticket;}),
  read:vi.fn(async(_t:any,adapter:any)=>{if(!staged){await adapter.messages('local-account','local-chat',{beforeFetch:(start:any)=>start()});staged=true;}}),
  nextPending:vi.fn(()=>confirmed?null:structuredClone(batch)),
  beforeDisclosure:vi.fn((_t:any,_seq:number,start:any)=>{if(revoked)throw Object.assign(new Error('Local grant revoked'),{code:'local_approval_required'});return start(structuredClone(batch));}),
  acknowledge:vi.fn((_t:any,ack:any)=>{expect(ack).toEqual({sequence:0,digest:batch.digest,chatId:'imported'});confirmed=true;}),abandon:vi.fn(),
 };
 const adapter={messages:vi.fn(async(_a:any,_c:any,options:any)=>options.beforeFetch(()=>({items:[],hasMore:false})))};
 return {directory,route,job,batch,authority,adapter,ticket,revoke:()=>{revoked=true;}};
}
const token='ocbr_'+'A'.repeat(43);
it('recovers a lost final ACK after process restart when ordinary claim is now idle',async()=>{
 const f=fixture();let imported=false,lost=true;const bodies:any[]=[];
 const fetch=vi.fn(async(url:string,init:any)=>{const body=JSON.parse(init.body);
  if(url.endsWith('/claim'))return response({job:imported?null:f.job});
  if(url.endsWith('/resume')){expect(body).toEqual({jobId:f.job.id});return response({job:{...f.job,nextSequence:1}});}
  if(url.endsWith('/deliver')){bodies.push(body);imported=true;if(lost){lost=false;throw new Error('response lost after commit');}return response({chatId:'imported',sequence:0,duplicate:true});}throw new Error('Unexpected route');});
 const transport=createBeeperRelayTransport({readToken:async()=>token,fetchImpl:fetch});
 let journal=new BeeperForegroundJournal(f.directory),runner=createBeeperForegroundRunner({connectionId:f.route,transport,authority:f.authority,adapter:f.adapter,journal});
 expect(await runner.runOne()).toMatchObject({status:'retry',reason:'relay_unavailable'});expect(journal.get(f.route)?.ticket.jobId).toBe(f.job.id);journal.close();
 journal=new BeeperForegroundJournal(f.directory);runner=createBeeperForegroundRunner({connectionId:f.route,transport,authority:f.authority,adapter:f.adapter,journal});
 expect(await runner.runOne()).toMatchObject({status:'complete'});expect(f.adapter.messages).toHaveBeenCalledTimes(1);expect(bodies[0]).toEqual(bodies[1]);expect(journal.get(f.route)).toBeNull();journal.close();
});
it('rechecks disclosure after token retrieval and never uploads a revoked cached batch',async()=>{
 const f=fixture();let resolve!:(v:string)=>void,entered!:()=>void,count=0;const waiting=new Promise<void>(done=>{entered=done;});
 const fetch=vi.fn(async(url:string)=>url.endsWith('/claim')?response({job:f.job}):response({ok:true}));
 const transport=createBeeperRelayTransport({readToken:async()=>{if(++count===2){entered();return new Promise<string>(done=>{resolve=done;});}return token;},fetchImpl:fetch});
 const journal=new BeeperForegroundJournal(f.directory),runner=createBeeperForegroundRunner({connectionId:f.route,transport,authority:f.authority,adapter:f.adapter,journal});
 const pending=runner.runOne();await waiting;f.revoke();resolve(token);expect(await pending).toMatchObject({status:'blocked',reason:'local_approval_required'});
 expect(fetch.mock.calls.some(([url])=>url.endsWith('/deliver'))).toBe(false);expect(f.authority.abandon).toHaveBeenCalledWith(f.ticket);expect(journal.get(f.route)).toBeNull();journal.close();
});
it('renews only the same failed lease without fetching another source page',async()=>{
 const f=fixture();let first=true;const leases:string[]=[];
 const fetch=vi.fn(async(url:string,init:any)=>{if(url.endsWith('/claim'))return response({job:f.job});if(url.endsWith('/resume'))return response({job:{...f.job,leaseId:'8'.repeat(48)}});
  if(url.endsWith('/deliver')){leases.push(JSON.parse(init.body).leaseId);if(first){first=false;return response({error:'lease_or_sequence_not_current'},409);}return response({sequence:0,chatId:'imported'});}throw new Error('Unexpected route');});
 const transport=createBeeperRelayTransport({readToken:async()=>token,fetchImpl:fetch}),journal=new BeeperForegroundJournal(f.directory),runner=createBeeperForegroundRunner({connectionId:f.route,transport,authority:f.authority,adapter:f.adapter,journal});
 expect(await runner.runOne()).toMatchObject({status:'retry'});expect(await runner.runOne()).toMatchObject({status:'complete'});expect(leases).toEqual([f.job.leaseId,'8'.repeat(48)]);expect(f.adapter.messages).toHaveBeenCalledTimes(1);journal.close();
});
it('reports permanent reconciliation failure and stops instead of looping silently',async()=>{
 const f=fixture(),failures:any[]=[];
 const fetch=vi.fn(async(url:string,init:any)=>{if(url.endsWith('/claim'))return response({job:f.job});if(url.endsWith('/deliver'))return response({error:'source_reconciliation_required',detail:'private-response-canary'},409);if(url.endsWith('/fail')){failures.push(JSON.parse(init.body));return response({ok:true});}throw new Error('Unexpected route');});
 const transport=createBeeperRelayTransport({readToken:async()=>token,fetchImpl:fetch}),journal=new BeeperForegroundJournal(f.directory),runner=createBeeperForegroundRunner({connectionId:f.route,transport,authority:f.authority,adapter:f.adapter,journal});
 expect(await runBeeperForeground({runner,signal:new AbortController().signal})).toMatchObject({status:'blocked',reason:'source_reconciliation_required'});expect(failures).toEqual([{jobId:f.job.id,leaseId:f.job.leaseId,code:'source_reconciliation_required'}]);expect(f.authority.abandon).toHaveBeenCalledWith(f.ticket);expect(journal.get(f.route)).toBeNull();journal.close();
});
it('does not start a source GET if local stop occurs during provider-token lookup',async()=>{
 const f=fixture(),stop=new AbortController();let finish!:(v:string)=>void,entered!:()=>void;const waiting=new Promise<void>(done=>{entered=done;});const get=vi.fn();
 const adapter=createBeeperReadonlyClient({readToken:()=>{entered();return new Promise<string>(done=>{finish=done;});},fetchImpl:get});
 const transport=createBeeperRelayTransport({readToken:async()=>token,fetchImpl:async()=>response({job:f.job}),signal:stop.signal});
 const journal=new BeeperForegroundJournal(f.directory),runner=createBeeperForegroundRunner({connectionId:f.route,transport,authority:f.authority,adapter,journal,signal:stop.signal});
 const pending=runner.runOne();await waiting;stop.abort();finish('synthetic-source-token');expect(await pending).toMatchObject({status:'stopped'});expect(get).not.toHaveBeenCalled();journal.close();
});
