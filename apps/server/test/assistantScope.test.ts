import { describe, expect, it, vi } from 'vitest';
import { replyAnnotation, scopeForParticipants, scopedToolInput, toolAvailableInScope } from '../src/services/assistantScope.js';
const group = { kind: 'conversation', conversationId: 'group' } as const;
describe('server-authorized per-turn scope', () => {
  it('only a real owner/bot direct DM can be universal; narrowing is turn local', () => {
    expect(scopeForParticipants('group','owner','bot','group',['owner','bot','other'],'universal')).toEqual(group);
    const members = ['owner','bot'];
    expect(scopeForParticipants('dm','owner','bot','direct',members,'conversation')?.kind).toBe('conversation');
    expect(scopeForParticipants('dm','owner','bot','direct',members)?.kind).toBe('universal');
    expect(scopeForParticipants('dm','owner','bot','direct',['bot'])).toBeNull();
  });
  it('denies private cross-chat tools, including crafted names absent from catalog', () => {
    for (const tool of ['vision_read','find_person','list_intents','unlinked_search_network','create_conversation','save_intent_draft','future_private_tool','send_message','post_context']) {
      expect(toolAvailableInScope(group, tool)).toBe(false);
      expect(scopedToolInput(group, tool, {userId:'owner'})).toBeNull();
    }
    for (const tool of ['read_messages','read_context']) {
      expect(scopedToolInput(group, tool, {conversationId:'private-dm'})).toBeNull();
      expect(scopedToolInput(group, tool, {person:'secret contact'})).toBeNull();
      expect(scopedToolInput(group, tool, {})).toEqual({conversationId:'group'});
    }
  });
});
describe('bounded server-resolved ancestry', () => {
  it('includes an old ancestor outside the latest context window', async () => {
    const lookup = vi.fn(async () => ({id:'old',conversationId:'group',senderName:'Alice',content:'Older scoped context'}));
    expect(await replyAnnotation('old','group',lookup)).toBe('Replying to Alice: Older scoped context');
    expect(lookup).toHaveBeenCalledWith('old');
  });
  it('inaccessible/cross-chat parents disclose neither name nor text', async () => {
    expect(await replyAnnotation('secret','group',async () => null)).toBe('Replying to an earlier message (unavailable)');
    expect(await replyAnnotation('secret','group',async () => ({id:'secret',conversationId:'private',senderName:'SECRET',content:'PRIVATE'}))).toBe('Replying to an earlier message (unavailable)');
  });
  it('stops cycles, depth and excerpt size', async () => {
    const lookup = vi.fn(async (id: string) => ({id,conversationId:'group',senderName:'User',content:'x'.repeat(5000),replyToId:String(Number(id)+1)}));
    const text = await replyAnnotation('1','group',lookup);
    expect(lookup).toHaveBeenCalledTimes(3); expect(text.length).toBeLessThan(3100);
    lookup.mockClear();
    await replyAnnotation('1','group',async id => ({id,conversationId:'group',senderName:'User',content:'cycle',replyToId:'1'}));
  });
});
