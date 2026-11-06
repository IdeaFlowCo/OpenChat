import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), saveAsk: vi.fn(), listAsks: vi.fn(), getAsk: vi.fn(), updateAsk: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: async () => {} }) }) }));
vi.mock('../src/services/privateGraph.js', async () => ({ ...(await vi.importActual('../src/services/privateGraph.js')), saveAsk: mocks.saveAsk, listAsks: mocks.listAsks, getAsk: mocks.getAsk, updateAsk: mocks.updateAsk }));
import { buildTools, executeTool } from '../src/services/assistant.js';
const source = 'Public: find a marketing person for example.test. Only synthetic Vlad: find invitees for a Matchmaking Party. Only me: VC intros this month for a fundraise.';
const boundary = { conversationId: 'private-agent', messageId: 'origin' };
const scope = { kind: 'universal', conversationId: boundary.conversationId } as const;
const row = (value: Record<string, unknown>) => ({ records: [{ get: (key: string) => value[key] }] });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
    if (query.includes('AS participants')) return row({ type: 'direct', participants: ['synthetic-owner', 'assistant'] });
    expect(params).toMatchObject({ ownerId: 'synthetic-owner', ...boundary });
    return row({ id: 'origin', content: source, transcript: null, attachments: null, createdAt: '2026-11-04T08:22:52.648Z' });
  });
  mocks.saveAsk.mockImplementation(async (_owner, input) => ({ ask: { id: `ask-${input.sourceReceipt.itemIndex}`, status: 'open', text: input.text }, created: true }));
});
describe('hosted canonical asks under server turn authority', () => {
  it('saves the three distinct synthetic asks with trusted owner/source, preserving audience without sending or matching', async () => {
    const inputs = [
      { text: 'Find a marketing person for example.test', excerpt: 'Public: find a marketing person for example.test.', itemIndex: 0, audienceIntent: 'Public', exposure: 'public' },
      { text: 'Find invitees for a Matchmaking Party', excerpt: 'Only synthetic Vlad: find invitees for a Matchmaking Party.', itemIndex: 1, audienceIntent: 'Only synthetic Vlad' },
      { text: 'VC intros this month for a fundraise', excerpt: 'Only me: VC intros this month for a fundraise.', itemIndex: 2, audienceIntent: 'Only me' },
    ];
    const results = await Promise.all(inputs.map(input => executeTool(undefined, 'synthetic-owner', 'save_ask', { ...input, ownerId: 'forged', sourceReceipt: { messageId: 'forged' }, carrier: 'forged' }, scope, boundary)));
    expect(results).toEqual(inputs.map((input, i) => ({ ask: { id: `ask-${i}`, text: input.text, status: 'open' }, created: true, publication: 'owner_only', delivery: 'none', matching: 'inactive' })));
    expect(mocks.saveAsk).toHaveBeenCalledTimes(3);
    for (const [i, call] of mocks.saveAsk.mock.calls.entries()) {
      expect(call[0]).toBe('synthetic-owner');
      expect(call[1]).toMatchObject({ author: 'self', sourceReceipt: { app: 'openchat', ...boundary, itemIndex: i, audienceIntent: inputs[i]!.audienceIntent, sourceMessageId: 'origin', sourceCreatedAt: '2026-11-04T08:22:52.648Z', assertion: 'stated' } });
      expect(call[1]).not.toHaveProperty('carrier');
      expect(call[2]).toEqual({ author: 'agent:OpenChat', source: 'app', assertion: 'stated' });
    }
  });
  it('denies shared-chat tools, missing origin, mismatched origin and invented evidence before saves', async () => {
    const group = { kind: 'conversation', conversationId: 'private-agent' } as const;
    for (const name of ['save_ask', 'list_asks', 'get_ask', 'update_ask', 'publish_ask', 'get_ask_publication', 'revoke_ask_publication']) {
      expect(buildTools(group).map(tool => tool.name)).not.toContain(name);
      expect(await executeTool(undefined, 'synthetic-owner', name, {}, group, boundary)).toHaveProperty('error');
      expect(buildTools(scope).map(tool => tool.name)).toContain(name);
    }
    expect(await executeTool(undefined, 'synthetic-owner', 'save_ask', {}, scope)).toHaveProperty('error');
    expect(await executeTool(undefined, 'synthetic-owner', 'save_ask', {}, scope, { ...boundary, conversationId: 'forged' })).toHaveProperty('error');
    expect(await executeTool(undefined, 'synthetic-owner', 'save_ask', { excerpt: 'Invented source' }, scope, boundary)).toHaveProperty('error');
    expect(mocks.saveAsk).not.toHaveBeenCalled();
  });
  it('binds an add-them-to-my-profile follow-up to the real prior ask-bearing message', async () => {
    mocks.run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      if (query.includes('AS participants')) return row({ type: 'direct', participants: ['synthetic-owner', 'assistant'] });
      expect(params).toMatchObject({ ownerId: 'synthetic-owner', conversationId: 'private-agent', messageId: 'follow-up', excerpt: 'Only me: VC intros this month for a fundraise.' });
      expect(query).toContain('m.createdAt < origin.createdAt');
      expect(query).toContain('senderId:$ownerId');
      return row({ id: 'original-ask-message', content: source, createdAt: '2026-11-04T08:22:52.648Z' });
    });
    await executeTool(undefined, 'synthetic-owner', 'save_ask', { text: 'VC intros this month for a fundraise', excerpt: 'Only me: VC intros this month for a fundraise.', itemIndex: 2, audienceIntent: 'Only me' }, scope, { ...boundary, messageId: 'follow-up' });
    expect(mocks.saveAsk).toHaveBeenCalledWith('synthetic-owner', expect.objectContaining({ sourceReceipt: expect.objectContaining({ messageId: 'follow-up', sourceMessageId: 'original-ask-message', sourceCreatedAt: '2026-11-04T08:22:52.648Z' }) }), expect.anything());
  });
  it('duplicates return existing lifecycle and never call update; explicit updates allowlisted to authenticated owner', async () => {
    mocks.saveAsk.mockResolvedValue({ ask: { id: 'ask-0', status: 'fulfilled' }, created: false });
    const input = { text: 'Find marketing', excerpt: 'Public:', itemIndex: 0, audienceIntent: 'Public' };
    expect(await executeTool(undefined, 'synthetic-owner', 'save_ask', input, scope, boundary)).toMatchObject({ ask: { status: 'fulfilled' }, created: false, publication: 'owner_only' });
    expect(mocks.updateAsk).not.toHaveBeenCalled();
    await executeTool(undefined, 'synthetic-owner', 'update_ask', { askId: 'ask-0', status: 'open', ownerId: 'forged', sourceReceipt: 'replace' }, scope, boundary);
    expect(mocks.updateAsk).toHaveBeenCalledWith('synthetic-owner', 'ask-0', { status: 'open' }, expect.objectContaining({ author: 'agent:OpenChat' }));
  });
});
