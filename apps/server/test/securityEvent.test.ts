import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSecurityEvent, securityRateLimitMonitor, TRUSTED_PROXY_SETTING } from '../src/services/securityEvent.js';
import { requireAuth } from '../src/middleware/auth.js';

let events: Record<string, unknown>[] = [];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  events = [];
  const original = process.stdout.write.bind(process.stdout);
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith('{"security_event"')) { events.push(JSON.parse(text)); return true; }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
});
afterEach(() => writeSpy.mockRestore());

function app() {
  const a = express();
  a.set('trust proxy', TRUSTED_PROXY_SETTING);
  a.use(securityRateLimitMonitor);
  a.get('/api/private', requireAuth, (_req, res) => { res.json({ ok: true }); });
  a.get('/limited', (_req, res) => { res.status(429).json({ error: 'rate_limited' }); });
  return a;
}

describe('security events', () => {
  it('trusts only loopback and private proxy hops', () => {
    const trust = app().get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('172.17.0.1', 0)).toBe(true);
    expect(trust('172.18.0.7', 0)).toBe(true);
    expect(trust('203.0.113.9', 0)).toBe(false);
    expect(trust('104.21.51.42', 0)).toBe(false);
  });

  it('uses the rightmost untrusted address, not a forged leftmost X-Forwarded-For', async () => {
    // Peer is loopback (trusted, like noos_nginx). nginx appended the edge it saw.
    await request(app()).get('/api/private')
      .set('authorization', 'Bearer forged.jwt.value')
      .set('x-forwarded-for', '6.6.6.6, 198.51.100.7');
    const event = events.find((e) => e.security_event === 'api_auth');
    expect(event).toMatchObject({ outcome: 'failure', reason: 'invalid_or_expired', ip: '198.51.100.7', path: '/api/private' });
    expect(JSON.stringify(event)).not.toContain('forged.jwt.value');
  });

  it('records missing credentials and 429 responses', async () => {
    const a = app();
    expect((await request(a).get('/api/private')).status).toBe(401);
    expect((await request(a).get('/limited').set('user-agent', 'u'.repeat(400))).status).toBe(429);
    expect(events.find((e) => e.security_event === 'api_auth')).toMatchObject({ outcome: 'denied', reason: 'missing_credentials' });
    const limited = events.find((e) => e.security_event === 'rate_limited');
    expect(limited).toMatchObject({ outcome: 'denied', path: '/limited' });
    expect(String(limited?.ua)).toHaveLength(200);
  });

  it('drops secrets and fingerprints emails', () => {
    const line = buildSecurityEvent('login', 'failure', {
      email: 'Person@Example.com', password: 'p4ss', token: 't0k', otpCode: '123456', api_key: 'oc_x', reason: 'bad',
    });
    expect(line).toMatchObject({ security_event: 'login', outcome: 'failure', email_domain: 'example.com', reason: 'bad' });
    expect(line.email_hash).toMatch(/^[0-9a-f]{12}$/);
    const text = JSON.stringify(line);
    for (const forbidden of ['Person@', 'person@', 'p4ss', 't0k', '123456', 'oc_x']) expect(text).not.toContain(forbidden);
  });
});
