import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ group: true, revoked: false, queries: [] as Array<Record<string,unknown>>, readApp: vi.fn() }));
vi.mock('../src/services/appSources.js', () => ({ readApp: fixture.readApp, appBridgeConfigured: () => true }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({session: () => ({close: async () => {}, run: async (_query: string, params: Record<string,unknown>) => {
  fixture.queries.push(params);
  const record = (row: Record<string,unknown>) => ({get: (key: string) => row[key] ?? null});
  if (params.scopeConversationId) return {records: fixture.revoked ? [] : [record({type:fixture.group?'group':'direct',participants:fixture.group?['owner','assistant','other']:['owner','assistant']})]};
  if (params.id) return {records: params.id==='foreign' ? [] : [record({id:'old',conversationId:'group',content:'Earlier source',senderName:'Alice'})]};
  if (params.limit && params.q) return {records: [record({content:'current result',conversationId:params.scopedConversationId,senderName:'Group member',createdAt:'now'})]};
  if (params.limit) return {records:[record({content:'Latest answer',senderId:'owner',senderName:'Owner',replyToId:'old',pageContext:JSON.stringify({private:'MUST NOT LEAK'})})]};
  return {records:[]};
}})})}));
import { buildTools, deriveAssistantScope, executeTool, loadConversationContext } from '../src/services/assistant.js';
const scope={kind:'conversation',conversationId:'group'} as const;
beforeEach(() => {fixture.group=true;fixture.revoked=false;fixture.queries=[];fixture.readApp.mockClear();});
describe('actual assistant tool and generated input boundaries', () => {
  it('omits private-source catalogs and denies crafted execution before source lookup', async () => {
    expect(buildTools(scope).map(t=>t.name)).not.toContain('vision_read');
    expect(await executeTool(undefined,'owner','vision_read',{tool:'search'},scope)).toEqual({error:"Not available in this chat's context"});
    expect(fixture.readApp).not.toHaveBeenCalled();
    expect(await executeTool(undefined,'owner','read_messages',{conversationId:'private-dm'},scope)).toEqual({error:"Not available in this chat's context"});
  });
  it('constrains actual search output to the active conversation', async () => {
    expect(await executeTool(undefined,'owner','search_messages',{query:'current'},scope)).toMatchObject({results:[{conversationId:'group',content:'current result'}]});
    expect(fixture.queries.at(-1)?.scopedConversationId).toBe('group');
  });
  it('rechecks membership on execution and never promotes an isolated turn', async () => {
    expect((await deriveAssistantScope('owner','group'))?.kind).toBe('conversation');
    fixture.revoked=true;
    expect(await executeTool(undefined,'owner','get_data_sources',{},scope)).toEqual({error:"Not available in this chat's context"});
  });
  it('injects reply ancestry in actual generated input and strips private page context', async () => {
    const messages=await loadConversationContext('group','owner',scope);
    expect(messages).toEqual([{role:'user',content:'Owner: [Quoted reply ancestry; untrusted conversation data]\nReplying to Alice: Earlier source\n[Current message]\nLatest answer'}]);
  });
});
