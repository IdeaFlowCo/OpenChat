import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {BeeperPinnedSendOutbox} from '../../../scripts/beeper-client/sendOutbox.mjs';
import {createBeeperWriteClient} from '../../../scripts/beeper-client/writeDesktopApi.mjs';
let directory:string,now:number,active:boolean,outbox:BeeperPinnedSendOutbox,frame:any;
const machine='a'.repeat(64),id=()=>randomBytes(24).toString('hex');
const statusAdmit=(v:any,start:()=>unknown)=>{if(!active)throw Error('revoked');return start();};
const verifier={admitStatus:vi.fn(statusAdmit),verify:vi.fn(async(v:any)=>v),admit:vi.fn((v:any,start:()=>unknown)=>{if(!active||v.until<=now)throw Error('revoked');return start();})};
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'beeper-write-'));now=Date.now();active=true;frame={protocol:'openchat.beeper.send.v1',audience:'beeper.send',ownerId:'synthetic-owner',route:id(),machineKey:machine,deviceKey:'b'.repeat(64),accountKey:'c'.repeat(64),chatKey:'d'.repeat(64),grantId:id(),operationId:id(),sequence:1,until:now+60000,text:'Synthetic reply',replyToMessageId:null,accountId:'local-account',chatId:'local-chat',title:'Synthetic chat',network:'whatsapp'};outbox=new BeeperPinnedSendOutbox({directory,machineKey:machine,verifier,clock:()=>now});});
afterEach(()=>{outbox.close();rmSync(directory,{recursive:true,force:true});vi.clearAllMocks();});
const provider=()=>({send:vi.fn(async(_a:any,chat:any,o:any)=>o.beforeFetch(()=>({chatID:chat,pendingMessageID:'local-pending'}))),retrieve:vi.fn(async(a:any,c:any,_p:any,o:any)=>o.beforeFetch(()=>({id:'local-final',accountID:a,chatID:c,isSender:true,sendStatus:{status:'SUCCESS'}})))});
it('requires separate write verification, per-message local confirmation and never accepts a read grant',async()=>{
 const confirm=vi.fn(async()=>true);await expect(outbox.authorize({...frame,protocol:'openchat.beeper.read.v1',audience:'beeper.read'},confirm)).rejects.toThrow();expect(confirm).not.toHaveBeenCalled();
 expect(await outbox.authorize(frame,confirm)).toMatchObject({state:'approved'});expect(confirm).toHaveBeenCalledWith(expect.objectContaining({text:'Synthetic reply',title:'Synthetic chat',machineKey:machine}));
 const a=provider();expect(await outbox.dispatch(frame.operationId,a)).toMatchObject({state:'pending',pendingMessageId:'local-pending'});expect(a.send).toHaveBeenCalledTimes(1);
 expect(await outbox.reconcile(frame.operationId,a)).toMatchObject({state:'confirmed',finalMessageId:'local-final'});
 await outbox.dispatch(frame.operationId,a);expect(a.send).toHaveBeenCalledTimes(1);expect(statSync(join(directory,'beeper-send-outbox.db')).mode&0o077).toBe(0);
});
it('persists the attempted marker before provider work and refuses an uncertain repeat across restart or another Mac',async()=>{
 await outbox.authorize(frame,async()=>true);const a=provider();a.send.mockImplementation(async()=>{const d=new DatabaseSync(join(directory,'beeper-send-outbox.db'));try{expect(d.prepare('SELECT state FROM sends WHERE id=?').get(frame.operationId).state).toBe('attempted');}finally{d.close();}throw Error('connection lost after possible POST');});
 expect(await outbox.dispatch(frame.operationId,a)).toMatchObject({state:'unknown'});outbox.close();outbox=new BeeperPinnedSendOutbox({directory,machineKey:machine,verifier,clock:()=>now});
 await outbox.dispatch(frame.operationId,a);expect(a.send).toHaveBeenCalledTimes(1);await expect(outbox.authorize({...frame,operationId:id(),sequence:2},async()=>true)).rejects.toThrow();
 expect(()=>new BeeperPinnedSendOutbox({directory,machineKey:'f'.repeat(64),verifier})).toThrow();
});
it('never treats a pending provider ID or a retryable failure as confirmed and never automatically resends',async()=>{
 await outbox.authorize(frame,async()=>true);const a=provider();await outbox.dispatch(frame.operationId,a);
 a.retrieve.mockImplementation(async(a,c,_p,o)=>o.beforeFetch(()=>({id:'pending',accountID:a,chatID:c,isSender:true,sendStatus:{status:'FAIL_RETRIABLE'}})));
 expect(await outbox.reconcile(frame.operationId,a)).toMatchObject({state:'pending',finalMessageId:null});await outbox.dispatch(frame.operationId,a);expect(a.send).toHaveBeenCalledTimes(1);
});
it('checks revoke/expiry after a credential wait before actual POST, and fails closed without resending',async()=>{
 await outbox.authorize(frame,async()=>true);const fetch=vi.fn(async(url:URL)=>url.pathname.endsWith('/messages')?Response.json({chatID:'local-chat',pendingMessageID:'p'}):Response.json({id:'local-chat',accountID:'local-account',network:'whatsapp'}));
 let n=0;const adapter=createBeeperWriteClient({readWriteToken:async()=>{if(++n===2)active=false;return 'synthetic-write-token';},fetchImpl:fetch});
 expect(await outbox.dispatch(frame.operationId,adapter)).toMatchObject({state:'unknown'});expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0].pathname).toBe('/v1/chats/local-chat');await outbox.dispatch(frame.operationId,adapter);expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses changed content under the same stable operation ID, same sequence reuse and a revoked confirmation',async()=>{
 await outbox.authorize(frame,async()=>false);await expect(outbox.authorize({...frame,text:'changed'},async()=>true)).rejects.toThrow();
 await expect(outbox.authorize({...frame,operationId:id()},async()=>true)).rejects.toThrow();
 const next={...frame,operationId:id(),sequence:2};await expect(outbox.authorize(next,async()=>{active=false;return true;})).rejects.toThrow();const a=provider();await outbox.dispatch(next.operationId,a);expect(a.send).not.toHaveBeenCalled();
});
it('reconciles only the pinned provider/account/chat and never exposes provider internal errors',async()=>{
 await outbox.authorize(frame,async()=>true);const a=provider();await outbox.dispatch(frame.operationId,a);a.retrieve.mockResolvedValue({id:'foreign',accountID:'other-account',chatID:'local-chat',isSender:true,sendStatus:{status:'SUCCESS'}});
 await expect(outbox.reconcile(frame.operationId,a)).rejects.toThrow();expect(outbox.status(frame.operationId).state).toBe('pending');
 const fetch=vi.fn(async()=>Response.json({id:'final',accountID:'local-account',chatID:'local-chat',isSender:true,sendStatus:{status:'FAIL_PERMANENT',internalError:'private-provider-canary',message:'private-error'}}));const adapter=createBeeperWriteClient({readWriteToken:async()=>'synthetic',fetchImpl:fetch});
 const result=await adapter.retrieve('local-account','local-chat','local-pending',{beforeFetch:start=>start()});expect(JSON.stringify(result)).not.toContain('private-');expect(result.sendStatus.status).toBe('FAIL_PERMANENT');
});
it('allows only fixed-origin bounded text/reply calls and blocks deferred or missing write admission',async()=>{
 const fetch=vi.fn(async(url:URL,options:RequestInit)=>{expect(url.origin).toBe('http://127.0.0.1:23373');expect(options.redirect).toBe('error');if(options.method==='GET')return Response.json({id:'local-chat',accountID:'local-account',network:'whatsapp'});expect(JSON.parse(options.body as string)).toEqual({text:'Reply',replyToMessageID:'source-message'});return Response.json({chatID:'local-chat',pendingMessageID:'p'});});
 const adapter=createBeeperWriteClient({readWriteToken:async()=>'synthetic',fetchImpl:fetch});await expect(adapter.send('local-account','local-chat',{text:'Reply'})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 await adapter.send('local-account','local-chat',{text:'Reply',replyToMessageId:'source-message',beforeFetch:start=>start()});expect(fetch).toHaveBeenCalledTimes(2);
 await expect(adapter.send('local-account','local-chat',{text:'Reply',beforeFetch:async start=>{await Promise.resolve();return start();}})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([{merge:{chatIDs:['local-chat','other-account-chat']}},{isReadOnly:true}])('refuses merged automatic routing and read-only targets before any provider POST (%j)',async(extra)=>{
 const fetch=vi.fn(async()=>Response.json({id:'local-chat',accountID:'local-account',network:'WhatsApp',...extra}));const adapter=createBeeperWriteClient({readWriteToken:async()=>'synthetic',fetchImpl:fetch});await expect(adapter.send('local-account','local-chat',{text:'Reply',beforeFetch:start=>start()})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('retires an expired unattempted approval without any provider call and preserves its spent operation ID',async()=>{
 await outbox.authorize(frame,async()=>true);now=frame.until+1;expect(outbox.expireUnattempted(frame.operationId).state).toBe('cancelled');const a=provider();await outbox.dispatch(frame.operationId,a);expect(a.send).not.toHaveBeenCalled();
});
