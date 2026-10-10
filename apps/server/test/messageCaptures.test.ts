import { describe, expect, it } from 'vitest';
import { captureKeys, parseCapture } from '../src/services/messageCaptures.js';
export const example = {channel:'imessage',sourceAccount:'test',sourceThreadId:'chat-a',threadTitle:'Example person',participants:['person@example.test'],sourceMessageId:'message-a',triggerMessageId:'reply-a',text:'An article to read',triggerText:'#longevity',sourceAt:'2026-10-01T00:00:00Z',capturedAt:'2026-10-02T00:00:00Z',tags:['Longevity'],pinned:false,destination:'stream',captureMethod:'reply'};
describe('external capture contract',()=>{
  it('normalizes source dates and tags without modifying original words',()=>{expect(parseCapture(example)).toMatchObject({text:example.text,tags:['longevity'],sourceAt:'2026-10-01T00:00:00.000Z'});});
  it('deduplicates the source across triggers and machines but keeps owners, channels and threads distinct',()=>{
    const a=parseCapture(example),keys=captureKeys('owner-a',a);
    expect(captureKeys('owner-a',{...a,triggerMessageId:'reaction-a'}).id).toBe(keys.id);
    expect(captureKeys('owner-a',{...a,triggerMessageId:'reaction-a'}).eventId).not.toBe(keys.eventId);
    expect(captureKeys('owner-b',a).id).not.toBe(keys.id);
    expect(captureKeys('owner-a',{...a,sourceThreadId:'chat-b'}).id).not.toBe(keys.id);
  });
  it.each([{pinned:'yes'},{channel:'whatsapp'},{tags:['x y']},{sourceAt:'not-a-date'},{text:''},{participants:'somebody'},{destination:'public'}])('rejects unsupported or malformed fields %j',patch=>{expect(()=>parseCapture({...example,...patch})).toThrow();});
});
