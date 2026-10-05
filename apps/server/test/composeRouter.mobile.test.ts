import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ storage: new Map<string, string>(), dispatch: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  setItem: async (key: string, value: string) => { mocks.storage.set(key, value); },
  getItem: async (key: string) => mocks.storage.get(key) || null,
  removeItem: async (key: string) => { mocks.storage.delete(key); },
} }));
vi.mock('@react-navigation/native', () => ({ CommonActions: { navigate: (payload: unknown) => payload } }));
vi.mock('../../mobile/src/services/notifications', () => ({ navigationRef: {
  isReady: () => true, getCurrentRoute: () => ({ name: 'Conversations' }), dispatch: mocks.dispatch,
  addListener: (name: string, listener: () => void) => { mocks.listeners.set(name, listener); return () => mocks.listeners.delete(name); },
} }));
import { captureComposeIntent, loadPendingComposeIntent } from '../../mobile/src/services/composeIntents';
import { ComposeRouter } from '../../mobile/src/navigation/ComposeRouter';
let root: ReturnType<typeof create> | undefined;
beforeEach(() => { vi.clearAllMocks(); mocks.storage.clear(); mocks.listeners.clear(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('routes B captured during A dispatch without deleting or dropping it', async () => {
  const a = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/a' };
  const b = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/b' };
  await captureComposeIntent(a);
  let capturedB: Promise<void> | undefined;
  mocks.dispatch.mockImplementationOnce(() => { capturedB = captureComposeIntent(b); mocks.listeners.get('state')?.(); });
  await act(async () => { root = create(React.createElement(ComposeRouter, { ready: true })); });
  await act(async () => { await capturedB; });
  const requests = mocks.dispatch.mock.calls.map(([action]) => action.params.params.params);
  expect(requests.map(request => request.profile)).toEqual([a.profile, b.profile]);
  expect(requests[0].requestRevision).not.toBe(requests[1].requestRevision);
  expect(await loadPendingComposeIntent()).toBeNull();
});
it('assigns fresh identity when the exact same link is captured twice', async () => {
  const intent = { source: 'unlinked' as const };
  await captureComposeIntent(intent);
  await act(async () => { root = create(React.createElement(ComposeRouter, { ready: true })); });
  await act(async () => { await captureComposeIntent(intent); });
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  const revisions = mocks.dispatch.mock.calls.map(([action]) => action.params.params.params.requestRevision);
  expect(revisions[0]).not.toBe(revisions[1]);
});
