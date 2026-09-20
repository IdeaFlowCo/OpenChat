import { describe, expect, it } from 'vitest';
import { resolveNoosPasswordOracleUrl, verifyPasswordViaNoos } from '../src/services/noosPasswordCheck.js';

const reply = (status: number, body: unknown = {}): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('verifyPasswordViaNoos', () => {
  it('returns the user id on success', async () => {
    expect(await verifyPasswordViaNoos('a@b.test', 'pw', 'http://localhost:1', reply(200, { user: { id: 'u1' } })))
      .toEqual({ status: 'ok', userId: 'u1' });
  });

  it.each([400, 401])('treats %i as a wrong password', async (status) => {
    expect(await verifyPasswordViaNoos('a@b.test', 'pw', 'http://localhost:1', reply(status)))
      .toEqual({ status: 'invalid' });
  });

  it.each([403, 404, 429, 500, 502, 503])('treats %i as unavailable, not as a wrong password', async (status) => {
    expect(await verifyPasswordViaNoos('a@b.test', 'pw', 'http://localhost:1', reply(status)))
      .toEqual({ status: 'unavailable' });
  });

  it('treats network errors and unusable 200 bodies as unavailable', async () => {
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await verifyPasswordViaNoos('a@b.test', 'pw', 'http://localhost:1', boom)).toEqual({ status: 'unavailable' });
    expect(await verifyPasswordViaNoos('a@b.test', 'pw', 'http://localhost:1', reply(200, {})))
      .toEqual({ status: 'unavailable' });
  });

  it('never sends an empty or oversized password', async () => {
    expect(await verifyPasswordViaNoos('a@b.test', '', 'http://localhost:1', reply(200, { user: { id: 'u' } })))
      .toEqual({ status: 'invalid' });
  });
});

describe('resolveNoosPasswordOracleUrl', () => {
  it('requires an explicit URL in production', () => {
    expect(resolveNoosPasswordOracleUrl(undefined, 'production')).toBeNull();
    expect(resolveNoosPasswordOracleUrl('', 'production')).toBeNull();
    expect(resolveNoosPasswordOracleUrl(undefined, 'development')).toBe('http://localhost:52743');
  });

  it('allows https and loopback http only', () => {
    expect(resolveNoosPasswordOracleUrl('https://globalbr.ai', 'production')).toBe('https://globalbr.ai');
    expect(resolveNoosPasswordOracleUrl('http://localhost:52743', 'production')).toBe('http://localhost:52743');
    expect(resolveNoosPasswordOracleUrl('http://127.0.0.1:52743', 'production')).toBe('http://127.0.0.1:52743');
    expect(resolveNoosPasswordOracleUrl('http://noos.internal:52743', 'production')).toBeNull();
    expect(resolveNoosPasswordOracleUrl('not a url', 'production')).toBeNull();
  });
});
