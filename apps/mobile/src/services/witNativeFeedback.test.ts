import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WIT_API_BASE,
  contextFooter,
  setNativeFeedbackUser,
  submitNativeFeedback,
  titleFromMessage,
  type FeedbackContext,
} from './witNativeFeedback';

const ctx: FeedbackContext = {
  app: 'OpenChat',
  version: '1.0.20',
  build: '2002',
  source: 'Settings',
  device: 'iPhone 15 Pro, iOS 18.1',
  platform: 'ios',
};

type Call = { url: string; init?: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function mockFetch(handler: (url: string, init: RequestInit | undefined, n: number) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const auth = (c: Call) => (c.init?.headers as Record<string, string> | undefined)?.Authorization;
const body = (c: Call) => JSON.parse(String(c.init?.body));

describe('witNativeFeedback', () => {
  beforeEach(() => setNativeFeedbackUser(null));

  it('builds the widget-compatible context footer', () => {
    expect(contextFooter(ctx)).toBe('App: OpenChat v1.0.20 (2002)\nSource: Settings\nDevice: iPhone 15 Pro, iOS 18.1');
    expect(contextFooter({ ...ctx, build: null })).toBe('App: OpenChat v1.0.20\nSource: Settings\nDevice: iPhone 15 Pro, iOS 18.1');
  });

  it('derives a short title from the first line', () => {
    expect(titleFromMessage('  Crash on open\nmore detail')).toBe('Crash on open');
    const long = titleFromMessage('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith('…')).toBe(true);
  });

  it('files signed-in feedback on openchat-feedback with the wfb1 bearer and no reporter claim', async () => {
    setNativeFeedbackUser(async () => ({ token: 'wfb1.abc', expires_at: Math.floor(Date.now() / 1000) + 900 }));
    const { fetch, calls } = mockFetch(() => json(201, { issue: { id: 'i-1', slug: 'crash-on-open', tracker_slug: 'openchat-feedback' } }));
    const result = await submitNativeFeedback({ message: 'Crash on open', anonymous: false, context: ctx }, { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${WIT_API_BASE}/create-issue`);
    expect(auth(calls[0])).toBe('Bearer wfb1.abc');
    expect((calls[0].init?.headers as Record<string, string>)['X-WIT-Client']).toBe('ios');
    const payload = body(calls[0]);
    expect(payload).toMatchObject({ tracker_slug: 'openchat-feedback', title: 'Crash on open', original_text: 'Crash on open', issue_type: 'bug' });
    expect(payload.reporter).toBeUndefined();
    expect(payload.description.endsWith(contextFooter(ctx))).toBe(true);
    expect(result).toEqual({ issueUrl: 'https://openchat-feedback.worldissuetracker.com/issue/crash-on-open', verified: true });
  });

  it('caches the token until a minute before expiry', async () => {
    const getter = vi.fn(async () => ({ token: 'wfb1.x', expires_at: Math.floor(Date.now() / 1000) + 900 }));
    setNativeFeedbackUser(getter);
    const { fetch } = mockFetch(() => json(201, { issue: { id: 'i' } }));
    await submitNativeFeedback({ message: 'a', anonymous: false, context: ctx }, { fetch });
    await submitNativeFeedback({ message: 'b', anonymous: false, context: ctx }, { fetch });
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('sends anonymously when the person opts out, is signed out, or the exchange fails', async () => {
    const { fetch, calls } = mockFetch(() => json(201, { issue: { id: 'i' } }));
    setNativeFeedbackUser(async () => ({ token: 'wfb1.abc', expires_at: Math.floor(Date.now() / 1000) + 900 }));
    expect((await submitNativeFeedback({ message: 'a', anonymous: true, context: ctx }, { fetch })).verified).toBe(false);
    setNativeFeedbackUser(null);
    await submitNativeFeedback({ message: 'b', anonymous: false, context: ctx }, { fetch });
    setNativeFeedbackUser(async () => { throw new Error('boom'); });
    await submitNativeFeedback({ message: 'c', anonymous: false, context: ctx }, { fetch });
    setNativeFeedbackUser(async () => ({ token: null }));
    await submitNativeFeedback({ message: 'd', anonymous: false, context: ctx }, { fetch });
    expect(calls.map(auth)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('retries once anonymously when WIT rejects the sender token', async () => {
    setNativeFeedbackUser(async () => ({ token: 'wfb1.stale', expires_at: Math.floor(Date.now() / 1000) + 900 }));
    const { fetch, calls } = mockFetch((_u, _i, n) => (n === 1 ? json(401, { error: 'invalid_token' }) : json(201, { issue: { id: 'i' } })));
    const result = await submitNativeFeedback({ message: 'a', anonymous: false, context: ctx }, { fetch });
    expect(calls.map(auth)).toEqual(['Bearer wfb1.stale', undefined]);
    expect(result.verified).toBe(false);
  });

  it('surfaces Retry-After on 429', async () => {
    const { fetch } = mockFetch(() => json(429, { error: 'rate_limited' }, { 'Retry-After': '30' }));
    await expect(submitNativeFeedback({ message: 'a', anonymous: true, context: ctx }, { fetch }))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 30 });
  });

  it('uploads a screenshot through create → signed PUT → finalize with the same bearer', async () => {
    setNativeFeedbackUser(async () => ({ token: 'wfb1.abc', expires_at: Math.floor(Date.now() / 1000) + 900 }));
    const { fetch, calls } = mockFetch((url) => {
      if (url.endsWith('/create-issue')) return json(201, { issue: { id: '11111111-1111-1111-1111-111111111111' } });
      if (url === 'file:///shot.jpg') return new Response(new Blob([new Uint8Array(5)], { type: 'image/jpeg' }));
      if (url.endsWith('/create-attachment-upload')) return json(200, { upload_url: 'https://storage.example/signed', storage_path: 'p/1', headers: { 'Content-Type': 'image/jpeg' } });
      if (url === 'https://storage.example/signed') return new Response(null, { status: 200 });
      if (url.endsWith('/finalize-attachment-upload')) return json(200, { attachment: { id: 'a' } });
      throw new Error(`unexpected ${url}`);
    });
    const result = await submitNativeFeedback({
      message: 'look',
      anonymous: false,
      context: ctx,
      screenshot: { uri: 'file:///shot.jpg', mimeType: 'image/jpeg', fileName: 'shot.jpg' },
    }, { fetch });
    expect(result.attachmentError).toBeUndefined();
    const create = calls.find((c) => c.url.endsWith('/create-attachment-upload'))!;
    expect(body(create)).toMatchObject({ issue_id: '11111111-1111-1111-1111-111111111111', mime_type: 'image/jpeg', byte_size: 5 });
    expect(auth(create)).toBe('Bearer wfb1.abc');
    const put = calls.find((c) => c.url === 'https://storage.example/signed')!;
    expect(auth(put)).toBeUndefined();
    expect(auth(calls.find((c) => c.url.endsWith('/finalize-attachment-upload'))!)).toBe('Bearer wfb1.abc');
  });

  it('still reports success when only the screenshot fails', async () => {
    const { fetch } = mockFetch((url) => {
      if (url.endsWith('/create-issue')) return json(201, { issue: { id: 'i' } });
      if (url === 'file:///shot.jpg') return new Response(new Blob([new Uint8Array(5)], { type: 'image/jpeg' }));
      return json(400, { error: 'unsupported_attachment_type' });
    });
    const result = await submitNativeFeedback({
      message: 'x', anonymous: true, context: ctx,
      screenshot: { uri: 'file:///shot.jpg', mimeType: 'image/jpeg', fileName: 'shot.jpg' },
    }, { fetch });
    expect(result.attachmentError).toBe('unsupported_attachment_type');
  });
});
