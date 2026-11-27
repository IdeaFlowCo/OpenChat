import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ avail: vi.fn(), ask: vi.fn(), handlers: new Map<string, (payload: unknown) => void>() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: (p: unknown) => React.createElement('Button', p) }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: (p: unknown) => React.createElement('AppIcon', p) }));
vi.mock('../../mobile/src/api/socket', () => ({ getSocket: () => ({ on: (e: string, h: (p: unknown) => void) => mocks.handlers.set(e, h), off: (e: string) => mocks.handlers.delete(e) }) }));
vi.mock('../../mobile/src/api/client', async () => {
  const { ApiError } = await import('../../mobile/src/api/errors');
  return { ApiError, api: { getProfileAgentAvailability: mocks.avail, askProfileAgent: mocks.ask } };
});
import { ApiError } from '../../mobile/src/api/errors';
import { myAgentErrorText, ProfileAgentAskControls } from '../../mobile/src/components/ProfileAgentAskControls';
import { ThreadAgentNotice, threadAgentFailureText } from '../../mobile/src/components/ThreadAgentNotice';
let screen: ReactTestRenderer;
beforeEach(() => { vi.resetAllMocks(); mocks.handlers.clear(); vi.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.avail.mockResolvedValue({ enabled: true, available: true }); });
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
const texts = () => screen.root.findAllByType('Text').map(n => [n.props.children].flat().join('')).join(' | ');
const notice = (text: string, onInsert = vi.fn(), conversationId = 'c') => React.createElement(ThreadAgentNotice, { conversationId, text, onInsert });

it('says who will see the answer before a tagged message is sent, and nothing for ordinary text', async () => {
  await act(async () => { screen = create(notice('lunch tomorrow?')); });
  expect(screen.toJSON()).toBeNull();
  await act(async () => { screen.update(notice('@agent what did we decide?')); });
  expect(texts()).toContain('Your OpenChat agent will answer here');
  expect(texts()).toContain('Everyone in this chat sees your message and its answer');
  await act(async () => { screen.update(notice('mail sam@agent.example.test')); });
  expect(screen.toJSON()).toBeNull();
});

it('offers the tag by its visible word while a mention is being typed', async () => {
  const insert = vi.fn();
  await act(async () => { screen = create(notice('so @ag', insert)); });
  expect(texts()).toContain('@agent');
  expect(texts()).toContain('Ask your agent about this chat');
  await act(async () => { screen.root.findByType('TouchableOpacity').props.onPress(); });
  expect(insert).toHaveBeenCalledOnce();
});

it('shows only this chat’s progress, explains a refusal in plain words and clears itself', async () => {
  await act(async () => { screen = create(notice('')); });
  const emit = (payload: unknown) => act(async () => { mocks.handlers.get('agent-reply:status')!(payload); });
  await emit({ conversationId: 'other', messageId: 'm', state: 'working' });
  expect(screen.toJSON()).toBeNull();
  await emit({ conversationId: 'c', messageId: 'm', state: 'working' });
  expect(texts()).toContain('Your agent is reading this chat');
  await emit({ conversationId: 'c', messageId: 'm', state: 'answered' });
  expect(screen.toJSON()).toBeNull();
  await emit({ conversationId: 'c', messageId: 'm', state: 'failed', code: 'cap' });
  expect(texts()).toContain('used its allowance');
  await act(async () => { vi.advanceTimersByTime(8100); });
  expect(screen.toJSON()).toBeNull();
  expect(threadAgentFailureText('surprising <b>server</b> text')).toBe('Your agent could not answer. Your message was sent; nothing else was posted.');
  expect(threadAgentFailureText('unavailable')).toContain('not available');
  expect(threadAgentFailureText('named')).toContain('mentions a person');
  expect(threadAgentFailureText('changed')).toContain('chat changed');
});

it('an answer clears only its own message’s line, and progress shows even where the tag is not offered', async () => {
  await act(async () => { screen = create(React.createElement(ThreadAgentNotice, { conversationId: 'c', text: '@agent typed while editing', onInsert: vi.fn(), offerTag: false })); });
  expect(screen.toJSON()).toBeNull();
  const emit = (payload: unknown) => act(async () => { mocks.handlers.get('agent-reply:status')!(payload); });
  await emit({ conversationId: 'c', messageId: 'newer', state: 'working' });
  await emit({ conversationId: 'c', messageId: 'older', state: 'answered' });
  expect(texts()).toContain('Your agent is reading this chat');
  await emit({ conversationId: 'c', messageId: 'newer', state: 'answered' });
  expect(screen.toJSON()).toBeNull();
  await emit({ conversationId: 'c', messageId: 'm', state: 'failed', code: 'named' });
  expect(texts()).toContain('Hold your message and choose Ask my agent');
});

it('“Ask my agent” explains what it reads, asks once as "mine" and never checks someone else’s opt-in', async () => {
  const answered = vi.fn();
  await act(async () => { screen = create(React.createElement(ProfileAgentAskControls, { messageId: 'm', name: 'Me', mine: true, onAnswered: answered })); });
  expect(mocks.avail).toHaveBeenCalledWith('m', 'mine');
  expect(texts()).toContain('Ask my agent');
  expect(texts()).toContain('labelled as your agent, not you');
  expect(texts()).toContain('only this chat’s recent messages and what you shared here');
  expect(texts()).toContain('Everyone in this chat sees the answer');
  await act(async () => { screen.root.findByType('TextInput').props.onChangeText(' What is open? '); });
  await act(async () => { screen.root.findAllByType('Button').find(n => n.props.label === 'Ask now')!.props.onPress(); });
  expect(mocks.ask).toHaveBeenCalledExactlyOnceWith('m', 'What is open?', 'mine');
  expect(answered).toHaveBeenCalledOnce();
  expect(myAgentErrorText(new ApiError(429, '429', JSON.stringify({ code: 'cap' })))).toBe('Your agent has used its allowance for this month.');
  expect(myAgentErrorText(new Error('secret internal'))).toBe('Your agent could not answer. Nothing was posted.');
});
