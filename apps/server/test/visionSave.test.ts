import { offerVisionSaveRecovery, type VisionRecoveryActions } from '../../mobile/src/utils/visionSaveRecovery';
import type { VisionSaveRequest, VisionSaveReview } from '../../mobile/src/api/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hash, ID_ISSUER, parseSaveRequest, reviewVisionSave, saveToVision, type SaveRecord, type SaveReceipt, type SaveRepository, type SaveRequest } from '../src/services/visionSave.js';
const input:SaveRequest={destination:'vision',kind:'excerpt',title:'Synthetic',body:'selected synthetic text',sourceRefs:[{app:'openchat',conversationId:'chat',messageId:'message',sourceDigest:hash('selected synthetic text')}],visibility:'private',idempotencyKey:'synthetic-save-key'};
let currentSource=input.body;
let changeDuringGrant=false,changeDuringReservation=false,rejectLost=false,beginLost=false;
let linked=true,source=true,grant=true,subject='owner-sub',writes=0,lostAck=false,finishLost=false;
let destinationURL='https://vision.ideaflow.app/n/synthetic-destination';
let ledger=new Map<string,SaveRecord & {reservationId?:string}>();
let nextReservation=0;
const repo:SaveRepository={
 async lookup(user,key){return ledger.get(user+':'+key)??null;},
 async identity(){return linked?{issuer:ID_ISSUER,subject:'owner-sub'}:null;},
 async source(){return source?currentSource:null;},
 async token(){return 'synthetic-connector-grant';},
 async reserve(user,key,hash,selectionHash,retryOf){
  if(changeDuringReservation)currentSource=input.body+' changed at reservation';
  const parent=retryOf?ledger.get(user+':'+retryOf):undefined;
  if(retryOf&&(!parent||parent.phase!=='rejected_before_dispatch'||parent.selectionHash!==selectionHash||(parent.successorKey&&parent.successorKey!==key)))return null;
  const id=user+':'+key,old=ledger.get(id);
  if(old)return {fresh:false,reservationId:'not-owner',...old};
  const value={hash,selectionHash,phase:'reserved',reservationId:'reservation-'+(++nextReservation),receipt:{status:'uncertain',reason:'dispatching'} as SaveReceipt};
  ledger.set(id,value);if(parent)parent.successorKey=key;
  return {fresh:true,...value};
 },
 async rejectBeforeDispatch(user,key,reservationId,receipt){
  if(rejectLost)throw Error('rejection persistence timeout');
  const row=ledger.get(user+':'+key);
  if(!row||row.phase!=='reserved'||row.reservationId!==reservationId)return false;
  row.phase='rejected_before_dispatch';row.receipt=receipt;return true;
 },
 async beginDispatch(user,key,reservationId){
  if(beginLost)return false;
  const row=ledger.get(user+':'+key);
  if(!row||row.phase!=='reserved'||row.reservationId!==reservationId)return false;
  row.phase='dispatching';return true;
 },
 async finish(user,key,receipt,reservationId){
  if(finishLost)throw Error('receipt ack lost');
  const row=ledger.get(user+':'+key)!;
  if(row.phase!=='dispatching'||row.reservationId!==reservationId)throw Error('wrong dispatch owner');
  row.phase='finished';row.receipt=receipt;
 }
};
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
beforeEach(()=>{currentSource=input.body;changeDuringGrant=false;changeDuringReservation=false;rejectLost=false;beginLost=false;nextReservation=0;destinationURL='https://vision.ideaflow.app/n/synthetic-destination';linked=true;source=true;grant=true;subject='owner-sub';writes=0;lostAck=false;finishLost=false;ledger=new Map();});
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

async function rejectAfterReservation(){
 changeDuringReservation=true;
 const receipt=await saveToVision('u',input,repo,fetchImpl);
 changeDuringReservation=false;
 expect(receipt).toMatchObject({status:'rejected',recoveryAvailable:true});expect(writes).toBe(0);
 return receipt;
}
async function reviewedAttempt(idempotencyKey='fresh-explicit-attempt'):Promise<SaveRequest>{
 const review=await reviewVisionSave('u',input,repo);
 expect(review.status).toBe('ready');
 if(review.status!=='ready')throw Error('review failed');
 return {...input,sourceRefs:review.sourceRefs,idempotencyKey,retryOf:input.idempotencyKey};
}
describe('durably proven rejection recovery at the real save boundary',()=>{
 it('refreshes source and dispatches an explicit new identity while preserving the old rejection',async()=>{
  const rejected=await rejectAfterReservation();
  const before=structuredClone(ledger.get('u:'+input.idempotencyKey)!);
  const next=await reviewedAttempt();
  expect(next.sourceRefs[0].sourceDigest).toBe(hash(currentSource));
  expect(next.sourceRefs[0].sourceDigest).not.toBe(input.sourceRefs[0].sourceDigest);expect(writes).toBe(0);
  expect(parseSaveRequest(next)).toEqual(next);
  expect(await saveToVision('u',next,repo,fetchImpl)).toMatchObject({status:'saved'});expect(writes).toBe(1);
  expect(ledger.get('u:'+input.idempotencyKey)).toMatchObject({hash:before.hash,phase:before.phase,receipt:before.receipt,successorKey:next.idempotencyKey});
  source=false;linked=false;grant=false;
  expect(await saveToVision('u',input,repo,fetchImpl)).toEqual(rejected);
  expect((await saveToVision('u',next,repo,fetchImpl)).status).toBe('saved');expect(writes).toBe(1);
 });
 it('offers review after a refreshed digest conflicts, without accepting the conflicting old payload',async()=>{
  await rejectAfterReservation();
  const refreshed={...input,sourceRefs:input.sourceRefs.map(r=>({...r,sourceDigest:hash(currentSource)}))};
  expect(await saveToVision('u',refreshed,repo,fetchImpl)).toMatchObject({status:'rejected',reason:'Idempotency key reused with different content',recoveryAvailable:true});
  expect((await reviewVisionSave('u',refreshed,repo)).status).toBe('ready');expect(writes).toBe(0);
 });
 it.each(['saved','uncertain','in-flight','reserved','missing','legacy-rejected','unproven-rejected','timeout'])('denies recovery for %s outcomes without proven non-dispatch',async kind=>{
  if(kind==='saved')await saveToVision('u',input,repo,fetchImpl);
  if(kind==='uncertain'){lostAck=true;await saveToVision('u',input,repo,fetchImpl);}
  if(kind==='in-flight'){finishLost=true;await expect(saveToVision('u',input,repo,fetchImpl)).rejects.toThrow();finishLost=false;}
  if(kind==='reserved'){beginLost=true;await expect(saveToVision('u',input,repo,fetchImpl)).rejects.toThrow();beginLost=false;}
  if(kind==='timeout'){rejectLost=true;changeDuringReservation=true;await expect(saveToVision('u',input,repo,fetchImpl)).rejects.toThrow();rejectLost=false;changeDuringReservation=false;}
  if(kind==='legacy-rejected'||kind==='unproven-rejected'){
   await saveToVision('u',input,repo,fetchImpl);
   const row=ledger.get('u:'+input.idempotencyKey)!;row.receipt={status:'rejected',reason:'Unproven',recoveryAvailable:true};delete row.phase;
   if(kind==='legacy-rejected')delete row.selectionHash;
  }
  const before=structuredClone(ledger.get('u:'+input.idempotencyKey)),beforeWrites=writes;
  expect((await reviewVisionSave('u',input,repo)).status).toBe('rejected');
  expect((await saveToVision('u',{...input,idempotencyKey:'new-recovery-attempt',retryOf:input.idempotencyKey},repo,fetchImpl)).status).toBe('rejected');
  if(before)expect((await saveToVision('u',input,repo,fetchImpl)).recoveryAvailable).toBeUndefined();
  expect(writes).toBe(beforeWrites);expect(ledger.get('u:'+input.idempotencyKey)).toEqual(before);
 });
 it('does not trust status, reason or recovery flags supplied by a client',async()=>{
  const parsed=parseSaveRequest({...input,idempotencyKey:'forged-client-attempt',retryOf:input.idempotencyKey,recoveryAvailable:true,phase:'rejected_before_dispatch',status:'rejected'});
  expect(parsed).not.toHaveProperty('phase');expect(parsed).not.toHaveProperty('recoveryAvailable');
  expect((await saveToVision('u',parsed!,repo,fetchImpl)).status).toBe('rejected');expect(writes).toBe(0);
 });
 it.each(['owner','identity','grant','source','digest','selection'])('rechecks %s for a fresh attempt after review',async changed=>{
  await rejectAfterReservation();const next=await reviewedAttempt();
  if(changed==='identity')linked=false;
  if(changed==='grant')grant=false;
  if(changed==='source')source=false;
  if(changed==='digest')currentSource+=' changed again';
  if(changed==='selection'){currentSource='selection was removed';next.sourceRefs[0].sourceDigest=hash(currentSource);}
  const receipt=await saveToVision(changed==='owner'?'another-owner':'u',next,repo,fetchImpl);
  expect(receipt.status).not.toBe('saved');expect(writes).toBe(0);
  expect(ledger.get('u:'+input.idempotencyKey)?.successorKey).toBeUndefined();
 });
 it('rejects an excerpt removed from the refreshed source without changing selected content',async()=>{
  await rejectAfterReservation();currentSource='different source';
  expect(await reviewVisionSave('u',input,repo)).toMatchObject({status:'rejected',reason:expect.stringContaining('selection no longer exists')});expect(writes).toBe(0);
 });
 it('detects another source change during fresh grant/reservation and preserves both receipts',async()=>{
  const rejected=await rejectAfterReservation(),next=await reviewedAttempt();
  changeDuringGrant=true;
  const receipt=await saveToVision('u',next,repo,fetchImpl);
  expect(receipt).toMatchObject({status:'rejected',recoveryAvailable:true});expect(writes).toBe(0);
  expect(await saveToVision('u',input,repo,fetchImpl)).toEqual(rejected);
  expect(ledger.get('u:'+next.idempotencyKey)?.phase).toBe('rejected_before_dispatch');
 });
 it('atomically permits only one successor identity, including concurrent recovery requests',async()=>{
  const rejected=await rejectAfterReservation(),next=await reviewedAttempt();
  const results=await Promise.all([saveToVision('u',next,repo,fetchImpl),saveToVision('u',{...next,idempotencyKey:'competing-new-attempt'},repo,fetchImpl)]);
  expect(results.map(r=>r.status).sort()).toEqual(['rejected','saved']);expect(writes).toBe(1);
  expect((await reviewVisionSave('u',input,repo)).status).toBe('rejected');
  expect(await saveToVision('u',input,repo,fetchImpl)).toEqual(rejected);
 });
 it.each(['saved','uncertain','in-flight'])('cannot reuse an old rejection to bypass a %s successor',async outcome=>{
  const rejected=await rejectAfterReservation(),next=await reviewedAttempt();
  lostAck=outcome==='uncertain';finishLost=outcome==='in-flight';
  if(finishLost)await expect(saveToVision('u',next,repo,fetchImpl)).rejects.toThrow();
  else expect((await saveToVision('u',next,repo,fetchImpl)).status).toBe(outcome==='saved'?'saved':'uncertain');
  finishLost=false;lostAck=false;
  expect((await saveToVision('u',{...next,idempotencyKey:'another-recovery-attempt'},repo,fetchImpl)).status).toBe('rejected');
  expect((await reviewVisionSave('u',input,repo)).status).toBe('rejected');
  expect((await saveToVision('u',{...next,idempotencyKey:'child-recovery-attempt',retryOf:next.idempotencyKey},repo,fetchImpl)).status).toBe('rejected');
  expect(await saveToVision('u',input,repo,fetchImpl)).toEqual(rejected);expect(writes).toBe(1);
 });
 it('does not consume or reclassify immutable historical outcomes through reservation transitions',async()=>{
  await saveToVision('u',input,repo,fetchImpl);
  const key='u:'+input.idempotencyKey,row=ledger.get(key)!,snapshot=structuredClone(row);
  expect(await repo.rejectBeforeDispatch('u',input.idempotencyKey,row.reservationId!,{status:'rejected',recoveryAvailable:true})).toBe(false);
  expect(await repo.beginDispatch('u',input.idempotencyKey,row.reservationId!)).toBe(false);
  expect(ledger.get(key)).toEqual(snapshot);expect(writes).toBe(1);
 });
 it('preserves content conflicts and rejects reused attempt identities',async()=>{
  await rejectAfterReservation();const next=await reviewedAttempt();
  expect(parseSaveRequest({...next,idempotencyKey:input.idempotencyKey})).toBeNull();
  for(const patch of [{body:'changed selection'},{title:'different title'},{kind:'note' as const}]){
   expect((await saveToVision('u',{...next,...patch},repo,fetchImpl)).status).toBe('rejected');
  }
  expect(writes).toBe(0);
 });
});

function recoveryUI(){
 const alerts:Array<{title:string;message:string;buttons:Parameters<VisionRecoveryActions['alert']>[2]}>=[];
 const actions={
  alert:vi.fn((title:string,message:string,buttons:Parameters<VisionRecoveryActions['alert']>[2])=>{alerts.push({title,message,buttons});}),
  review:vi.fn(async(next:VisionSaveRequest)=>await reviewVisionSave('u',next,repo) as VisionSaveReview),
  newAttemptKey:vi.fn(()=> 'explicit-ui-attempt'),
  submit:vi.fn(async(next:VisionSaveRequest)=>(await saveToVision('u',next,repo,fetchImpl)).status==='saved'),
 };
 const press=(label:string)=>alerts.at(-1)!.buttons.find(button=>button.text===label)!.onPress?.();
 return {alerts,actions,press};
}
describe('real recovery presenter through review and save boundaries',()=>{
 it('requires refresh/review and then an explicit new attempt with the retained selection',async()=>{
  const rejected=await rejectAfterReservation(),ui=recoveryUI();
  expect(offerVisionSaveRecovery(input as VisionSaveRequest,rejected,ui.actions)).toBe(true);
  expect(ui.alerts.at(-1)?.title).toBe('Save rejected before dispatch');
  expect(ui.actions.review).not.toHaveBeenCalled();expect(ui.actions.newAttemptKey).not.toHaveBeenCalled();expect(writes).toBe(0);
  ui.press('Refresh and review');
  await vi.waitFor(()=>expect(ui.alerts.at(-1)?.title).toBe('Review refreshed source'));
  expect(ui.alerts.at(-1)?.message).toContain(input.body);expect(ui.alerts.at(-1)?.message).toContain(currentSource);
  expect(ui.actions.submit).not.toHaveBeenCalled();expect(ui.actions.newAttemptKey).not.toHaveBeenCalled();expect(writes).toBe(0);
  ui.press('Start new save attempt');ui.press('Start new save attempt');
  await vi.waitFor(()=>expect(writes).toBe(1));
  expect(ui.actions.newAttemptKey).toHaveBeenCalledOnce();expect(ui.actions.submit).toHaveBeenCalledOnce();
  expect(ui.actions.submit.mock.calls[0][0]).toMatchObject({body:input.body,idempotencyKey:'explicit-ui-attempt',retryOf:input.idempotencyKey,sourceRefs:[{sourceDigest:hash(currentSource)}]});
  expect(await saveToVision('u',input,repo,fetchImpl)).toEqual(rejected);
 });
 it.each(['saved','uncertain','needs_auth','unavailable','rejected'] as const)('does not offer this recovery for %s without eligible rejection metadata',status=>{
  const ui=recoveryUI();
  expect(offerVisionSaveRecovery(input as VisionSaveRequest,{status,recoveryAvailable:status!=='rejected'},ui.actions)).toBe(false);
  expect(ui.alerts).toEqual([]);expect(ui.actions.newAttemptKey).not.toHaveBeenCalled();expect(ui.actions.submit).not.toHaveBeenCalled();
 });
 it('keeps selection and offers no new attempt when refreshed source no longer contains it',async()=>{
  const rejected=await rejectAfterReservation(),ui=recoveryUI();currentSource='selection removed';
  offerVisionSaveRecovery(input as VisionSaveRequest,rejected,ui.actions);ui.press('Refresh and review');
  await vi.waitFor(()=>expect(ui.alerts.at(-1)?.title).toBe('New attempt unavailable'));
  expect(ui.alerts.at(-1)?.buttons.map(b=>b.text)).toEqual(['Keep selection']);
  expect(ui.actions.newAttemptKey).not.toHaveBeenCalled();expect(ui.actions.submit).not.toHaveBeenCalled();expect(writes).toBe(0);
 });
 it('cannot turn a review timeout into authority for a fresh attempt',async()=>{
  const rejected=await rejectAfterReservation(),ui=recoveryUI();ui.actions.review.mockRejectedValueOnce(Error('transport timeout'));
  offerVisionSaveRecovery(input as VisionSaveRequest,rejected,ui.actions);ui.press('Refresh and review');
  await vi.waitFor(()=>expect(ui.alerts.at(-1)?.title).toBe('Review unavailable'));
  expect(ui.actions.newAttemptKey).not.toHaveBeenCalled();expect(ui.actions.submit).not.toHaveBeenCalled();expect(writes).toBe(0);
 });
 it('review is not automatic write authority when grants are revoked before the final action',async()=>{
  const rejected=await rejectAfterReservation(),ui=recoveryUI();
  offerVisionSaveRecovery(input as VisionSaveRequest,rejected,ui.actions);ui.press('Refresh and review');
  await vi.waitFor(()=>expect(ui.alerts.at(-1)?.title).toBe('Review refreshed source'));
  grant=false;ui.press('Start new save attempt');
  await vi.waitFor(()=>expect(ui.actions.submit).toHaveBeenCalledOnce());
  expect(await ui.actions.submit.mock.results[0].value).toBe(false);expect(writes).toBe(0);
  expect(ledger.get('u:'+input.idempotencyKey)?.receipt).toEqual(rejected);
 });
});
