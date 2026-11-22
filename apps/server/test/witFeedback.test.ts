import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// OpenChat-0xjt: feedback is filed under the filer's unified Ideaflow account
// by default, anonymous only on request, and never silently as the key owner.
const h = vi.hoisted(() => ({ users: {} as Record<string, Record<string, unknown>> }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({
  close: async () => {},
  run: async (_q: string, params: { userId: string }) => {
    const row = h.users[params.userId];
    return { records: row ? [{ get: (k: string) => row[k] ?? null }] : [] };
  },
}) }) }));

const requests: Array<{ path: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
let delegation = 200;
let server: Server;
let svc: typeof import('../src/services/witFeedback.js');

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, headers: { ...req.headers }, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/delegate') {
      res.statusCode = delegation;
      res.end(JSON.stringify(delegation === 200 ? { access_token: `tok-${body.subject}` } : { error: 'nope' }));
      return;
    }
    if (req.url === '/feedback-token') {
      res.end(JSON.stringify({ success: true, token: `wfb1.${String(req.headers.authorization).slice(7)}`, expires_at: Math.floor(Date.now() / 1000) + 900, scope: 'create-issue' }));
      return;
    }
    if (req.url === '/create-issue') {
      res.end(JSON.stringify({ success: true, issue: { id: 'i1', slug: 'openchat-bug' } }));
      return;
    }
    res.end(JSON.stringify({ intake_id: 'receipt-1', status: 'held_for_review' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv('WIT_API_BASE', base);
  vi.stubEnv('IDEAFLOW_DELEGATION_URL', `${base}/delegate`);
  vi.stubEnv('IDEAFLOW_BUILTIN_CLIENT_ID', 'openchat');
  vi.stubEnv('IDEAFLOW_BUILTIN_CLIENT_SECRET', 'builtin-secret');
  vi.stubEnv('WIT_AGENT_KEY', 'server-key');
  svc = await import('../src/services/witFeedback.js');
});
beforeEach(() => {
  vi.stubEnv("WIT_PRODUCT_FEEDBACK", "on");
  requests.length = 0;
  delegation = 200;
  h.users = {
    linked: { name: 'Ada Lovelace', issuer: 'https://id.ideaflow.app/api/auth', subject: 'sub-ada' },
    legacy: { name: 'Grace Hopper', issuer: null, subject: null },
  };
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  vi.unstubAllEnvs();
});

const create = () => requests.find((r) => r.path === '/product-feedback')!;

describe('fileFeedback', () => {
  it('keeps the existing WIT route when the feature is off', async () => {
    vi.stubEnv('WIT_PRODUCT_FEEDBACK', '');
    const result = await svc.fileFeedback({ userId: 'legacy', message: 'Existing route', source: 'app' });
    expect(result.ok).toBe(true);
    expect(requests.map(request => request.path)).toEqual(['/create-issue']);
  });
  it('uses the app-scoped token and returns the held receipt', async () => {
    const idempotencyKey = 'bad1d8ec-5398-4b6b-94ac-a6e7e97fac32';
    const result = await svc.fileFeedback({ userId: 'linked', message: 'Search is slow', source: 'app', idempotencyKey });
    expect(result).toMatchObject({ ok: true, postedAs: 'account', displayName: 'Ada Lovelace', id: 'receipt-1', receiptStatus: 'held_for_review' });
    expect(create().headers.authorization).toBe('Bearer wfb1.tok-sub-ada');
    expect(create().headers['x-agent-key']).toBeUndefined();
    expect(create().body).toEqual({ app: 'openchat', kind: 'other', title: 'Search is slow', details: 'Search is slow', idempotency_key: idempotencyKey });
  });

  it('does not send an identity or a key with anonymous feedback', async () => {
    const result = await svc.fileFeedback({ userId: 'linked', message: 'Private bug', anonymous: true, source: 'assistant' });
    expect(result).toMatchObject({ ok: true, postedAs: 'anonymous' });
    expect(result).not.toHaveProperty('displayName');
    expect(requests.map(row => row.path)).toEqual(['/product-feedback']);
    expect(create().headers.authorization).toBeUndefined();
    expect(create().headers['x-agent-key']).toBeUndefined();
    expect(JSON.stringify(create().body)).not.toMatch(/Ada|linked/);
  });

  it('keeps a linked sender from falling back to a second receipt identity', async () => {
    delegation = 503;
    h.users.failed = { name: 'Test', issuer: 'https://id.ideaflow.app/api/auth', subject: 'sub-failed' };
    const result = await svc.fileFeedback({ userId: 'failed', message: 'Test', source: 'app' });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(requests.map(request => request.path)).toEqual(['/delegate']);
  });

  it('uses the shared connector key without a reporter claim when no caller token exists', async () => {
    const result = await svc.fileFeedback({ userId: 'legacy', message: 'Crash on open', source: 'app' });
    expect(result).toMatchObject({ ok: true, postedAs: 'connector', receiptStatus: 'held_for_review' });
    expect(create().headers['x-agent-key']).toBe('server-key');
    expect(create().body.reporter).toBeUndefined();
    expect(JSON.stringify(create().body)).not.toMatch(/Grace|legacy/);
  });

  it('defaults to the GCP World Issue Tracker API', () => {
    vi.stubEnv('WIT_API_BASE', '');
    expect(svc.witApiBase()).toBe('https://api.worldissuetracker.com/functions/v1');
  });
});

describe('witWidgetToken', () => {
  // The default-base test above blanks WIT_API_BASE; point it back at the fake.
  beforeEach(() => { vi.stubEnv('WIT_API_BASE', String(process.env.IDEAFLOW_DELEGATION_URL).replace(/\/delegate$/, '')); });
  it('exchanges the delegated WIT bearer for a wfb1. token and caches it per person', async () => {
    h.users.fresh = { name: 'Test', issuer: 'https://id.ideaflow.app/api/auth', subject: 'sub-fresh' };
    const first = await svc.witWidgetToken('fresh');
    expect(first).toEqual({ token: 'wfb1.tok-sub-fresh', expires_at: expect.any(Number) });
    const exchange = requests.find((r) => r.path === '/feedback-token')!;
    expect(exchange.headers.authorization).toBe('Bearer tok-sub-fresh');
    expect(exchange.body).toEqual({ app: 'openchat' });
    expect(await svc.witWidgetToken('fresh')).toEqual(first);
    expect(requests.filter((r) => r.path === '/delegate')).toHaveLength(1);
  });

  it('returns null (anonymous) without an Ideaflow identity or when delegation fails', async () => {
    expect(await svc.witWidgetToken('legacy')).toBeNull();
    delegation = 503;
    expect(await svc.witWidgetToken('nobody')).toBeNull();
    expect(requests.some((r) => r.path === '/feedback-token')).toBe(false);
  });
});
