import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ mode: 'auto', language: 'English', ready: true, request: vi.fn() }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity', Platform: { OS: 'web' }, StyleSheet: { create: (s: unknown) => s } }));
vi.mock('../../mobile/src/api/client', () => ({ authenticatedFetch: vi.fn(), getToken: vi.fn(), OPENCHAT_URL: '' }));
vi.mock('../../mobile/src/contexts/TranslationContext', () => ({ useChatTranslation: () => ({ context: { ready: state.ready, queue }, preference: { mode: state.mode, language: state.language } }) }));
vi.mock('../../mobile/src/components/MessageText', () => ({ MessageText: ({ content }: { content: string }) => React.createElement('Text', {}, content) }));
import { TranslatedMessage } from '../../mobile/src/components/TranslatedMessage.js';
import { TranslationQueue, likelyNeedsTranslation, readTranslationPreferences } from '../../mobile/src/services/translation.js';
const queue = { request: state.request };
let screen: ReturnType<typeof create>;
const base = { conversationId: 'chat', content: '你好', incoming: true, requested: false, active: true, color: 'black', onLongPress: vi.fn() };
const render = (props = {}) => React.createElement(TranslatedMessage, { ...base, ...props }, React.createElement('Text', {}, (props as any).content || '你好'));
const text = () => JSON.stringify(screen.toJSON());
beforeEach(() => { state.mode = 'auto'; state.language = 'English'; state.ready = true; state.request.mockReset(); state.request.mockResolvedValue({ text: 'Hello', sourceLanguage: 'Chinese', translated: true }); });
afterEach(async () => { if (screen) await act(async () => screen.unmount()); });
describe('reading translated messages', () => {
  it('labels automatic translations and toggles the untouched original', async () => {
    await act(async () => { screen = create(render()); });
    expect(text()).toContain('Hello'); expect(text()).toContain('Auto-translated');
    await act(async () => screen.root.findByType('TouchableOpacity').props.onPress());
    expect(text()).toContain('你好'); expect(text()).toContain('Show translation');
    await act(async () => screen.root.findByType('TouchableOpacity').props.onPress());
    expect(text()).toContain('Hello');
  });
  it.each(['off', 'ask'])('does not send text in %s mode until a manual request', async mode => {
    state.mode = mode;
    await act(async () => { screen = create(render()); });
    expect(state.request).not.toHaveBeenCalled(); expect(text()).toContain('你好');
    await act(async () => screen.update(render({ requested: true })));
    expect(state.request).toHaveBeenCalledOnce(); expect(text()).toContain('Translated');
  });
  it('cancels on disable, shows original immediately, and ignores late completion', async () => {
    let resolve!: (value: unknown) => void;
    state.request.mockImplementation(() => new Promise(r => { resolve = r; }));
    await act(async () => { screen = create(render()); });
    const signal = state.request.mock.calls[0][2];
    state.mode = 'off'; await act(async () => screen.update(render()));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ text: 'Late result', sourceLanguage: 'Chinese', translated: true }));
    expect(text()).toContain('你好'); expect(text()).not.toContain('Late result');
  });
  it('retranslates edits and target changes instead of displaying stale text', async () => {
    await act(async () => { screen = create(render()); });
    state.request.mockResolvedValueOnce({ text: 'Goodbye', sourceLanguage: 'Chinese', translated: true });
    await act(async () => screen.update(render({ content: '再见' })));
    expect(text()).toContain('Goodbye'); expect(text()).not.toContain('Hello');
    state.language = 'French'; await act(async () => screen.update(render({ content: '再见' })));
    expect(state.request.mock.calls.at(-1)?.[1]).toBe('French');
  });
  it('keeps original on errors and retries only on explicit action', async () => {
    state.request.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { screen = create(render()); });
    expect(text()).toContain('你好'); expect(text()).toContain('Retry translation');
    expect(state.request).toHaveBeenCalledOnce();
    await act(async () => screen.root.findByType('TouchableOpacity').props.onPress());
    expect(text()).toContain('Hello');
  });
  it('does not auto-translate outgoing messages, emoji, inactive chats, or before preferences load', async () => {
    for (const props of [{ incoming: false }, { content: '👍 123' }, { active: false }]) {
      await act(async () => { screen = create(render(props)); });
      await act(async () => screen.unmount());
    }
    state.ready = false; await act(async () => { screen = create(render()); });
    expect(state.request).not.toHaveBeenCalled();
  });
  it('does not label same-language messages as translated or truncate long originals', async () => {
    state.request.mockResolvedValue({ text: 'Hello', sourceLanguage: 'English', translated: false });
    await act(async () => { screen = create(render({ content: 'Hello' })); });
    expect(text()).not.toContain('Auto-translated');
    const long = '中'.repeat(12001); await act(async () => screen.update(render({ content: long })));
    expect(text()).toContain(long); expect(text()).toContain('too long'); expect(state.request).toHaveBeenCalledOnce();
  });
});
it('offers Chinese–English translation locally without guessing from URLs/emoji', () => {
  expect(likelyNeedsTranslation('你好！', 'English')).toBe(true);
  expect(likelyNeedsTranslation('繁體中文', 'English')).toBe(true);
  expect(likelyNeedsTranslation('Hello 你好', 'English')).toBe(true);
  expect(likelyNeedsTranslation('Hello!', 'Chinese (Simplified)')).toBe(true);
  expect(likelyNeedsTranslation('https://example.com/你好 👍', 'English')).toBe(false);
  expect(likelyNeedsTranslation('👍 123', 'English')).toBe(false);
});
it('validates saved preferences and per-chat overrides', () => {
  expect(readTranslationPreferences('broken').mode).toBe('ask');
  expect(readTranslationPreferences('{"mode":"bad","language":"bad"}').language).toBe('English');
  expect(readTranslationPreferences('{"mode":"auto","chats":{"a":{"mode":"off"}}}').chats.a).toEqual({ mode: 'off' });
});
it('caches by text and target, serializes, skips cancelled queued work and isolates accounts', async () => {
  const send = vi.fn().mockResolvedValue({ text: 'Hello', sourceLanguage: 'Chinese', translated: true });
  const q = new TranslationQueue(send, 0); const signal = new AbortController().signal;
  await Promise.all([q.request('你好', 'English', signal), q.request('你好', 'English', signal)]);
  expect(send).toHaveBeenCalledOnce();
  await q.request('你好', 'French', signal); expect(send).toHaveBeenCalledTimes(2);
  const aborted = new AbortController(); aborted.abort();
  await expect(q.request('再见', 'English', aborted.signal)).rejects.toThrow('cancelled');
  expect(send).toHaveBeenCalledTimes(2);
  await new TranslationQueue(send, 0).request('你好', 'English', signal); expect(send).toHaveBeenCalledTimes(3);
});
