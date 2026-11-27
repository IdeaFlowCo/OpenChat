import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import clientLogs from '../src/routes/clientLogs.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSecurityEvent, securityRateLimitMonitor } from '../src/services/securityEvent.js';
import { createNginxProxyTrust, type ProxyTrust } from '../src/services/nginxProxyTrust.js';
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

function app(trust: ProxyTrust = () => false) {
  const a = express();
  a.set('trust proxy', trust);
  a.use(securityRateLimitMonitor);
  a.use('/api/client-logs', clientLogs);
  a.get('/api/private', requireAuth, (_req, res) => { res.json({ ok: true }); });
  a.get('/origin', (req, res) => {
    res.json({ protocol: req.protocol, secure: req.secure, hostname: req.hostname });
  });
  a.get('/limited', (_req, res) => { res.status(429).json({ error: 'rate_limited' }); });
  return a;
}

async function withPeer(address: string, test: (trust: ProxyTrust) => Promise<void>) {
  const pin = createNginxProxyTrust('noos_nginx', async family => family === 4 ? [{ address, ttl: 60 }] : []);
  try { await pin.refresh(); await test(pin.trust); } finally { pin.close(); }
}

describe('security events', () => {
  it('trusts only the pinned immediate nginx peer for Express address and protocol attribution', () => withPeer('172.18.0.8', async trust => {
    expect(trust('172.18.0.8', 0)).toBe(true);
    expect(trust('::ffff:172.18.0.8', 0)).toBe(true);
    expect(trust('172.18.0.8', 1)).toBe(false);
    for (const peer of ['127.0.0.1', '172.18.0.1', '172.18.0.7', 'fd00::1', '203.0.113.9'])
      expect(trust(peer, 0)).toBe(false);
    expect(app().get('trust proxy fn')('172.18.0.8', 0)).toBe(false);
  }));

  it('logs the direct socket address for api_auth even when the request supplies forwarding headers', () => withPeer('172.18.0.8', async trust => {
    await request(app(trust)).get('/api/private')
      .set('x-forwarded-for', '203.0.113.77')
      .set('cf-connecting-ip', '203.0.113.77')
      .expect(401);
    const event = events.find(e => e.security_event === 'api_auth');
    expect(event).toMatchObject({ ip: expect.stringMatching(/^(::ffff:)?127\.0\.0\.1$/), outcome: 'denied' });
    expect(event).not.toHaveProperty('xff');
    expect(event).not.toHaveProperty('cf_connecting_ip');
  }));

  it('uses the rightmost untrusted address, not a forged leftmost X-Forwarded-For', () => withPeer('127.0.0.1', async trust => {
    // Peer is loopback (trusted, like noos_nginx). nginx appended the edge it saw.
    await request(app(trust)).get('/api/private')
      .set('authorization', 'Bearer forged.jwt.value')
      .set('x-forwarded-for', '6.6.6.6, 198.51.100.7');
    const event = events.find((e) => e.security_event === 'api_auth');
    expect(event).toMatchObject({ outcome: 'failure', reason: 'invalid_or_expired', ip: '198.51.100.7', path: '/api/private' });
    expect(JSON.stringify(event)).not.toContain('forged.jwt.value');
  }));

  it('derives origin and secure transport properties from the exact immediate hop', async () => {
    for (const [peer, trusted] of [['127.0.0.1', true], ['172.18.0.8', false]] as const) {
      await withPeer(peer, async trust => {
        await request(app(trust)).get('/origin').set('host', 'app.internal')
          .set('x-forwarded-host', 'chat.ideaflow.app').set('x-forwarded-proto', 'https')
          .expect(200, { protocol: trusted ? 'https' : 'http', secure: trusted,
            hostname: trusted ? 'chat.ideaflow.app' : 'app.internal' });
      });
    }
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

  it('keeps independent edge telemetry budgets and serves authenticated HTTP if the upstream is still a shared peer', async () => {
    const logger = vi.spyOn(console, 'log').mockImplementation(() => {});
    const syntheticSecret = randomBytes(32).toString('hex');
    vi.stubEnv('JWT_SECRET', syntheticSecret);
    const token = jwt.sign({ userId: 'native-fixture', email: 'fixture@example.invalid' }, syntheticSecret);
    try {
      await withPeer('127.0.0.1', async trust => {
        const throughNginx = app(trust);
        for (let n = 0; n < 120; n++)
          await request(throughNginx).post('/api/client-logs').set('x-forwarded-for', '198.51.100.1').expect(200);
        await request(throughNginx).post('/api/client-logs').set('x-forwarded-for', '198.51.100.1').expect(429);
        await request(throughNginx).post('/api/client-logs').set('x-forwarded-for', '198.51.100.2').expect(200);
      });
      await withPeer('172.18.0.8', async trust => {
        const throughOldGateway = app(trust);
        // Both sender hints come from the same untrusted transport peer.
        for (let n = 0; n < 120; n++)
          await request(throughOldGateway).post('/api/client-logs').set('x-forwarded-for', '198.51.100.3').expect(200);
        await request(throughOldGateway).post('/api/client-logs').set('x-forwarded-for', '198.51.100.4').expect(429);
        await request(throughOldGateway).get('/api/private').set('Authorization', 'Bearer ' + token).expect(200);
        await request(throughOldGateway).get('/api/private').expect(401);
      });
    } finally { vi.unstubAllEnvs(); logger.mockRestore(); }
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
