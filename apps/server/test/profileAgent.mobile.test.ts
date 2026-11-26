import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ask: vi.fn(), settings: vi.fn(), rules: vi.fn(), drafts: vi.fn(), createRule: vi.fn(), send: vi.fn(), convs: vi.fn(), me: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Switch: 'Switch', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/ui', () => ({
  Button: (p: unknown) => React.createElement('Button', p), Chip: (p: unknown) => React.createElement('Chip', p),
  SectionLabel: (p: { children: string }) => React.createElement('SectionLabel', p),
}));
vi.mock('../../mobile/src/api/client', async () => {
  const { ApiError } = await import('../../mobile/src/api/errors');
  return { ApiError, api: { askProfileAgent: mocks.ask, getAutoResponseSettings: mocks.settings, listAutoResponseRules: mocks.rules, listAutoResponseDrafts: mocks.drafts,
    createAutoResponseRule: mocks.createRule, sendAutoResponseDraft: mocks.send, getConversations: mocks.convs, getMe: mocks.me } };
});
import { ApiError } from '../../mobile/src/api/errors';
import { ProfileAgentAskControls, profileAgentErrorText } from '../../mobile/src/components/ProfileAgentAskControls';
import { AgentAutoResponses, describeRule } from '../../mobile/src/components/AgentAutoResponses';
let screen: ReactTestRenderer;
beforeEach(() => {
  vi.resetAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.settings.mockResolvedValue({ profileAgentEnabled: true, available: true, spentMicros: 120000, capMicros: 2000000 });
  mocks.rules.mockResolvedValue({ rules: [] }); mocks.drafts.mockResolvedValue({ drafts: [] });
  mocks.convs.mockResolvedValue([{ id: 'c', type: 'direct', participants: [{ user: { id: 'me', name: 'Me' } }, { user: { id: 'ben', name: 'Ben Synthetic' } }] }]);
  mocks.me.mockResolvedValue({ id: 'me' });
});
afterEach(async () => { await act(async () => screen?.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
const texts = () => screen.root.findAllByType('Text').map(n => [n.props.children].flat().join('')).join(' | ');
const byLabel = (t: string, label: string) => screen.root.findAllByType(t).find(n => n.props.label === label)!;

it('explains what the agent sees, sends the optional question once and reports refusals in plain words', async () => {
  const answered = vi.fn();
  await act(async () => { screen = create(React.createElement(ProfileAgentAskControls, { messageId: 'm', name: 'Ana', onAnswered: answered })); });
  expect(texts()).toContain('labelled as their agent, not Ana');
  expect(texts()).toContain('only knows what Ana shared');
  await act(async () => { screen.root.findByType('TextInput').props.onChangeText('  When?  '); });
  let resolve!: (v: unknown) => void; mocks.ask.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  await act(async () => { byLabel('Button', 'Ask now').props.onPress(); });
  await act(async () => { byLabel('Button', 'Asking…').props.onPress(); });
  expect(mocks.ask).toHaveBeenCalledExactlyOnceWith('m', 'When?');
  await act(async () => resolve({ message: {} })); expect(answered).toHaveBeenCalledOnce();
  expect(profileAgentErrorText(new ApiError(409, '409', JSON.stringify({ code: 'off' })), 'Ana')).toBe('Ana has turned off their OpenChat agent.');
  expect(profileAgentErrorText(new ApiError(429, '429', JSON.stringify({ code: 'cap' })), 'Ana')).toContain('allowance');
  expect(profileAgentErrorText(new Error('secret internal'), 'Ana')).toBe('The agent could not answer. Nothing was posted.');
});

it('new rules default to drafts; auto-send is an explicit, explained choice', async () => {
  await act(async () => { screen = create(React.createElement(AgentAutoResponses)); });
  expect(texts()).toContain('It never reads your private notes');
  expect(texts()).toContain('Used $0.12 of $2.00 this month');
  expect(byLabel('Chip', 'Draft for my approval').props.selected).toBe(true);
  expect(texts()).toContain('Nothing is sent until you approve');
  await act(async () => { screen.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'Reply text')!.props.onChangeText('Away until Monday.'); });
  await act(async () => { byLabel('Button', 'Add rule').props.onPress(); });
  expect(mocks.createRule).toHaveBeenLastCalledWith(expect.objectContaining({ whenAway: true, delivery: 'draft', action: 'reply', replyText: 'Away until Monday.' }));
  await act(async () => { byLabel('Chip', 'Send automatically').props.onPress(); });
  expect(texts()).toContain('labelled “Automatic reply');
  expect(byLabel('Chip', 'Ben Synthetic')).toBeDefined();
});

it('shows drafts for approval and sends the owner-edited text', async () => {
  mocks.drafts.mockResolvedValue({ drafts: [{ id: 'd', conversationId: 'c', sourceMessageId: 'm', ruleId: 'r', text: 'Agent draft', action: 'agent', senderName: 'Ben', sourceText: 'ping', createdAt: '', expiresAt: '' }] });
  await act(async () => { screen = create(React.createElement(AgentAutoResponses)); });
  expect(texts()).toContain('approved by you');
  await act(async () => { screen.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'Draft reply to Ben')!.props.onChangeText('Edited reply'); });
  await act(async () => { byLabel('Button', 'Send').props.onPress(); });
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('d', 'Edited reply');
});

it('describes rules in plain words', () => {
  expect(describeRule({ whenAway: true, fromUserIds: ['ben'], topics: ['invoice'], action: 'agent', delivery: 'send' }, [{ id: 'ben', name: 'Ben' }]))
    .toBe('When I’m away · from Ben · about invoice → my agent writes a reply, sent automatically');
});
