import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({run:vi.fn(),publish:vi.fn(),get:vi.fn(),revoke:vi.fn()}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({run:mocks.run,close:async()=>{}})})}));
vi.mock('../src/services/askPublications.js',()=>({getAskPublication:mocks.get,publishAsk:mocks.publish,revokeAskPublication:mocks.revoke}));
import { executeAskTool } from '../src/services/assistantAsks.js';
import { clearAskPublicationReview, pendingAskPublicationContext } from '../src/services/askPublicationReviews.js';
const owner='review-owner',chat='review-dm';
const readyAt=Date.parse('2026-11-06T02:00:00Z');
const first={conversationId:chat,messageId:'preview-turn'},next={conversationId:chat,messageId:'approval-turn'};
const input={askId:'public-ask',requestId:'public-request',expectedAskRevision:0,expectedPublicationRevision:null,text:'Approved marketing excerpt',audience:{kind:'public'},confirm:false};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(readyAt);vi.clearAllMocks();mocks.run.mockResolvedValue({records:[{get:(key:string)=>key==='createdAt'?new Date(readyAt+10).toISOString():'verified'}]});mocks.publish.mockImplementation(async(_owner,_actor,_askId,payload)=>payload.confirm?{publication:{id:'published',state:'active'}}:{approvalRequired:true,approvalGrant:`grant-${payload.requestId}`,preview:{text:payload.text,audience:payload.audience.kind}});});
afterEach(()=>{clearAskPublicationReview(owner,chat,'public-ask');clearAskPublicationReview(owner,chat,'selected-ask');vi.useRealTimers();});
describe('hosted publication approval across user turns',()=>{
  it('keeps exact review state across turns and refuses same-turn activation',async()=>{
    await executeAskTool(owner,'publish_ask',input,first);
    const confirmed={...input,confirm:true,approvalGrant:'grant-public-request'};
    expect(await executeAskTool(owner,'publish_ask',confirmed,first)).toHaveProperty('error');expect(mocks.publish).toHaveBeenCalledTimes(1);
    const context=pendingAskPublicationContext(owner,chat,next.messageId,readyAt+10);expect(context).toContain('Approved marketing excerpt');expect(context).toContain('grant-public-request');
    expect(pendingAskPublicationContext('another-owner',chat,next.messageId,readyAt+10)).toBe('');expect(pendingAskPublicationContext(owner,'another-chat',next.messageId,readyAt+10)).toBe('');
    expect(await executeAskTool(owner,'publish_ask',confirmed,next)).toMatchObject({publication:{state:'active'}});
    expect(mocks.publish).toHaveBeenLastCalledWith(owner,`${owner}:assistant`,'public-ask',expect.objectContaining({confirm:true,approvalGrant:'grant-public-request'}));
    expect(pendingAskPublicationContext(owner,chat,next.messageId,readyAt+10)).toBe('');
  });
  it('does not clear a different pending review or accept changed text/audience',async()=>{
    await executeAskTool(owner,'publish_ask',input,first);
    const selected={...input,askId:'selected-ask',requestId:'selected-request',text:'Party invitees',audience:{kind:'people',targets:[{kind:'openchat_user',id:'vlad'}]}};
    await executeAskTool(owner,'publish_ask',selected,first);
    expect(await executeAskTool(owner,'publish_ask',{...input,text:'Changed text',confirm:true,approvalGrant:'grant-public-request'},next)).toHaveProperty('error');
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    await executeAskTool(owner,'publish_ask',{...input,confirm:true,approvalGrant:'grant-public-request'},next);
    const pending=pendingAskPublicationContext(owner,chat,'later-turn',readyAt+10);expect(pending).toContain('Party invitees');expect(pending).not.toContain('Approved marketing excerpt');
  });
  it('rejects queued turns before the server review boundary, including after-origin and equal timestamps',async()=>{
    // The preview's originating user turn is older than a queued second turn;
    // neither may confirm a review the server has only just finished preparing.
    mocks.run.mockResolvedValueOnce({records:[{get:(key:string)=>key==='createdAt'?new Date(readyAt-2000).toISOString():'verified'}]});
    await executeAskTool(owner,'publish_ask',input,first);
    for(const timestamp of [readyAt-1000,readyAt-1,readyAt,null]){
      mocks.run.mockResolvedValue({records:[{get:(key:string)=>key==='createdAt'?timestamp===null?null:new Date(timestamp).toISOString():'verified'}]});
      expect(pendingAskPublicationContext(owner,chat,'queued-turn',timestamp)).toBe('');
      expect(await executeAskTool(owner,'publish_ask',{...input,confirm:true,approvalGrant:'grant-public-request'},{conversationId:chat,messageId:'queued-turn'})).toHaveProperty('error');
    }
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it('expires safely and rejects a deleted/unavailable authorization message',async()=>{
    vi.useFakeTimers();await executeAskTool(owner,'publish_ask',input,first);vi.advanceTimersByTime(10*60_000);
    expect(pendingAskPublicationContext(owner,chat,next.messageId,readyAt+10)).toBe('');
    expect(await executeAskTool(owner,'publish_ask',{...input,confirm:true,approvalGrant:'grant-public-request'},next)).toHaveProperty('error');expect(mocks.publish).toHaveBeenCalledTimes(1);
    mocks.run.mockResolvedValue({records:[]});expect(await executeAskTool(owner,'publish_ask',input,next)).toHaveProperty('error');expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
