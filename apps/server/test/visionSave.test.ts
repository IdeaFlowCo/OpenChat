import { beforeEach, describe, expect, it } from 'vitest';
import { hash, ID_ISSUER, parseSaveRequest, saveToVision, type SaveReceipt, type SaveRepository, type SaveRequest } from '../src/services/visionSave.js';
const input:SaveRequest={destination:'vision',kind:'excerpt',title:'Synthetic',body:'selected synthetic text',sourceRefs:[{app:'openchat',conversationId:'chat',messageId:'message',sourceDigest:hash('selected synthetic text')}],visibility:'private',idempotencyKey:'synthetic-save-key'};
let currentSource=input.body;
let changeDuringGrant=false,changeDuringReservation=false;
let linked=true,source=true,grant=true,subject='owner-sub',writes=0,lostAck=false,finishLost=false;
let destinationURL='https://vision.ideaflow.app/n/synthetic-destination';
let ledger=new Map<string,{hash:string;receipt:SaveReceipt}>();
const repo:SaveRepository={async lookup(user,key){return ledger.get(user+':'+key)??null;},async identity(){return linked?{issuer:ID_ISSUER,subject:'owner-sub'}:null;},async source(){return source?currentSource:null;},async token(){return 'synthetic-connector-grant';},async reserve(user,key,hash){if(changeDuringReservation)currentSource='changed at reservation';const id=user+':'+key;const old=ledger.get(id);if(old)return {fresh:false,...old};const value={hash,receipt:{status:'uncertain',reason:'dispatching'} as SaveReceipt};ledger.set(id,value);return {fresh:true,...value};},async finish(user,key,receipt){if(finishLost)throw Error('receipt ack lost');ledger.get(user+':'+key)!.receipt=receipt;}};
const fetchImpl=(async(url:string,options?:RequestInit)=>{
 if(url.endsWith('/agent/keys/status')){if(changeDuringGrant)currentSource='changed while checking grant';return new Response(JSON.stringify({status:'active',identity:{issuer:ID_ISSUER,subject},scopes:grant?['vision:read','vision:write']:['vision:read']}),{status:200});}
 writes++;
 const request=JSON.parse(String(options?.body));
 expect(request.params).toMatchObject({name:'vision__create_note',arguments:{visibility:'private'}});
 expect(Object.keys(request.params.arguments).sort()).toEqual(['bodyMd','visibility']);
 expect(request.params.arguments.bodyMd).toContain(input.body);
 expect(request.params.arguments.bodyMd).toContain('openchat-save:');
 expect(request.params.arguments.bodyMd).toContain('https://chat.ideaflow.app/app/chat/chat?message=message');
 if(lostAck)throw Error('destination ack lost');
 return new Response(JSON.stringify({result:{content:[{type:'text',text:JSON.stringify({note:{id:'synthetic-destination'},url:destinationURL})}]}}),{status:200});
}) as typeof fetch;
beforeEach(()=>{currentSource=input.body;changeDuringGrant=false;changeDuringReservation=false;destinationURL='https://vision.ideaflow.app/n/synthetic-destination';linked=true;source=true;grant=true;subject='owner-sub';writes=0;lostAck=false;finishLost=false;ledger=new Map();});
describe('real scoped connector save contract with executable destination fixture',()=>{
 it('private save returns persisted destination receipt and retries do not write twice',async()=>{expect(await saveToVision('u',input,repo,fetchImpl)).toMatchObject({status:'saved',destinationId:'synthetic-destination'});expect(await saveToVision('u',input,repo,fetchImpl)).toMatchObject({status:'saved'});expect(writes).toBe(1);});
 it('destination receipt cannot redirect to a lookalike Vision host',async()=>{destinationURL='https://vision.ideaflow.app.evil.example/n/synthetic';expect((await saveToVision('u',input,repo,fetchImpl)).url).toBe('https://vision.ideaflow.app/');});
 it('rejects conflicting idempotency payload',async()=>{await saveToVision('u',input,repo,fetchImpl);expect(await saveToVision('u',{...input,title:'changed'},repo,fetchImpl)).toMatchObject({status:'rejected'});expect(writes).toBe(1);});
 it('no linkage, inaccessible source, mismatched owner or revoked write grant cannot dispatch',async()=>{linked=false;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('needs_auth');linked=true;source=false;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('rejected');source=true;subject='foreign-owner';expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('needs_auth');subject='owner-sub';grant=false;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('needs_auth');expect(writes).toBe(0);});
 it('lost destination acknowledgment stays uncertain after retry, no duplicate',async()=>{lostAck=true;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('uncertain');lostAck=false;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('uncertain');expect(writes).toBe(1);});
 it('crash between destination success and ledger acknowledgment cannot cause replay',async()=>{finishLost=true;await expect(saveToVision('u',input,repo,fetchImpl)).rejects.toThrow();finishLost=false;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('uncertain');expect(writes).toBe(1);});
 it('saved receipt survives source deletion, unlinking and grant revocation without another write',async()=>{await saveToVision('u',input,repo,fetchImpl);source=false;linked=false;grant=false;expect(await saveToVision('u',input,repo,fetchImpl)).toMatchObject({status:'saved',destinationId:'synthetic-destination'});expect(writes).toBe(1);});
 it('uncertain history can only create a new copy with a new explicit save identity and fresh authority',async()=>{lostAck=true;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('uncertain');lostAck=false;expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('uncertain');expect(writes).toBe(1);grant=false;expect((await saveToVision('u',{...input,idempotencyKey:'new-user-confirmed-copy'},repo,fetchImpl)).status).toBe('needs_auth');expect(writes).toBe(1);grant=true;expect((await saveToVision('u',{...input,idempotencyKey:'new-user-confirmed-copy'},repo,fetchImpl)).status).toBe('saved');expect(writes).toBe(2);});
 it('legacy committed uncertain reservation returns its exact searchable marker without dispatch or current source/grant',async()=>{lostAck=true;finishLost=true;await expect(saveToVision('u',input,repo,fetchImpl)).rejects.toThrow();finishLost=false;linked=false;source=false;grant=false;const result=await saveToVision('u',input,repo,fetchImpl);expect(result.status).toBe('uncertain');expect(result.reason).toMatch(/openchat-save:[a-f0-9]{64}/);expect(writes).toBe(1);});
 it.each(['summary','answer','note','excerpt'] as const)('rejects stale full-source digest for %s even if excerpt still exists',async kind=>{
  currentSource=input.body+' changed context';
  expect(await saveToVision('u',{...input,kind},repo,fetchImpl)).toMatchObject({status:'rejected',reason:expect.stringContaining('Source changed')});
  expect(writes).toBe(0);expect(ledger.size).toBe(0);
 });
 it.each(['grant','reservation'])('rechecks source changes during %s before dispatch',async stage=>{
  changeDuringGrant=stage==='grant';changeDuringReservation=stage==='reservation';
  expect((await saveToVision('u',input,repo,fetchImpl)).status).toBe('rejected');expect(writes).toBe(0);
 });
 it('parses versionless legacy lookups but refuses to dispatch new ones',async()=>{
  const legacy={...input,sourceRefs:input.sourceRefs.map(({sourceDigest,...ref})=>ref)};
  const parsed=parseSaveRequest(legacy)!;expect(parsed).toEqual(legacy);
  expect((await saveToVision('u',parsed,repo,fetchImpl)).status).toBe('rejected');expect(writes).toBe(0);
  const legacyHash=hash(JSON.stringify([legacy.destination,legacy.kind,legacy.title,legacy.body,legacy.sourceRefs.map(r=>[r.app,r.conversationId,r.messageId]),legacy.visibility]));
  ledger.set('u:'+input.idempotencyKey,{hash:legacyHash,receipt:{status:'saved',destinationId:'historical'}});
  linked=false;source=false;grant=false;
  expect(await saveToVision('u',parsed,repo,fetchImpl)).toMatchObject({status:'saved',destinationId:'historical'});
  expect(await saveToVision('u',input,repo,fetchImpl)).toMatchObject({status:'saved',destinationId:'historical'});
  expect((await saveToVision('u',{...parsed,body:'conflicting'},repo,fetchImpl)).status).toBe('rejected');expect(writes).toBe(0);
 });
 it('versioned historical receipts retain payload conflicts and owner isolation',async()=>{
  await saveToVision('u',input,repo,fetchImpl);source=false;linked=false;
  expect((await saveToVision('u',{...input,sourceRefs:input.sourceRefs.map(r=>({...r,sourceDigest:hash('different')}))},repo,fetchImpl)).status).toBe('rejected');
  expect((await saveToVision('other',input,repo,fetchImpl)).status).toBe('needs_auth');expect(writes).toBe(1);
 });
 it('rejects public visibility and arbitrary destination/source references',()=>{expect(parseSaveRequest({...input,visibility:'public'})).toBeNull();expect(parseSaveRequest({...input,destination:'external-url'})).toBeNull();expect(parseSaveRequest({...input,sourceRefs:[{app:'vision',messageId:'foreign'}]})).toBeNull();expect(parseSaveRequest({...input,sourceRefs:[]})).toBeNull();expect(parseSaveRequest(input)).toEqual(input);});
});
