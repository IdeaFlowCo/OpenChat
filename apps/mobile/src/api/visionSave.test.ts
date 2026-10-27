import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => null, setItem: async () => {}, removeItem: async () => {},
} }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {},
}));

import { api, ApiError, clearSession, setSession } from './client';
import { ApiError as PublicApiError } from './errors';
import { setAuthenticatedRequestGuard } from './authenticatedRequest';
import { presentVisionSaveFailure } from '../utils/visionSaveFeedback';

const input = {
  destination: 'vision', kind: 'excerpt', title: 'Synthetic', body: 'Synthetic selection',
  sourceRefs: [{ app: 'openchat', conversationId: 'synthetic-chat', messageId: 'synthetic-message', sourceDigest: 'a'.repeat(64) }],
  visibility: 'private', idempotencyKey: 'synthetic-attempt',
} as const;
let release: () => void;
beforeEach(async () => {
  await setSession('synthetic-token', { userId: 'synthetic-owner', email: 'owner@example.invalid' });
  release = setAuthenticatedRequestGuard(async token => token === 'synthetic-token');
});
afterEach(async () => { release(); await clearSession(); vi.unstubAllGlobals(); });

it.each([
  [503, JSON.stringify({ status: 'uncertain', reason: 'Check Vision for openchat-save:' + 'b'.repeat(64) }), 'Save outcome unknown'],
  [503, 'malformed receipt', 'Save receipt unavailable'],
  [503, JSON.stringify({ status: 'unavailable' }), 'Save receipt unavailable'],
  [400, JSON.stringify({ status: 'uncertain' }), 'Save receipt unavailable'],
])('presents the actual authenticated save response (%s, %s)', async (status, body, title) => {
  const transport = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', transport);
  const alert = vi.fn();
  let failure: unknown;
  try { await api.saveToVision({ ...input, sourceRefs: [...input.sourceRefs] }); }
  catch (error) { failure = error; presentVisionSaveFailure(error, alert); }
  expect(ApiError).toBe(PublicApiError);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ status, body });
  expect(alert).toHaveBeenCalledOnce();
  expect(alert.mock.calls[0][0]).toBe(title);
  if (title === 'Save outcome unknown') {
    expect(alert.mock.calls[0][1]).toContain('openchat-save:' + 'b'.repeat(64));
    expect(alert.mock.calls[0][1]).toContain('duplicate');
  } else expect(alert.mock.calls[0][1]).toContain('may have saved');
  expect(transport).toHaveBeenCalledOnce();
  const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
  expect(new URL(url).pathname).toBe('/api/vision/saves');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual(input);
});
