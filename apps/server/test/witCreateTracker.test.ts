import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWitTrackerCreationMode, toolWitCreateTracker } from '../src/services/externalActions.js';

// world-issue-tracker-wkn4: OpenChat's WIT tracker creation keeps the
// owner-only identity gate. Only the configured owner sends the WIT agent key;
// everyone else creates anonymously, and an owner failure never retries
// anonymously.

const OWNER = 'owner-user-id';
const ENV_KEYS = ['OPENCHAT_OWNER_USER_ID', 'WIT_AGENT_KEY', 'WIT_ANON_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function mockFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const created = (kind: 'anonymous' | 'agent_key') => ({
  success: true,
  tracker: { id: 't1', slug: 'fix-potholes', name: 'Fix Potholes', url: 'https://worldissuetracker.com/tracker/fix-potholes' },
  creator: { kind, user_id: kind === 'anonymous' ? null : 'wit-user' },
});

// Each test uses a distinct OpenChat user id so the in-memory per-user write
// limiter never leaks between tests.
let n = 0;
const user = () => `user-${++n}`;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.OPENCHAT_OWNER_USER_ID = OWNER;
  process.env.WIT_AGENT_KEY = 'wit_owner_key';
  process.env.WIT_ANON_KEY = 'anon-jwt';
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('toolWitCreateTracker', () => {
  it('creates anonymously for non-owner users without sending the owner key', async () => {
    const calls = mockFetch(200, created('anonymous'));
    const result = await toolWitCreateTracker(user(), { name: ' Fix Potholes ', anonymous: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/create-tracker$/);
    expect(calls[0].headers['X-Agent-Key']).toBeUndefined();
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].headers['X-WIT-Client']).toBe('openchat');
    expect(calls[0].body.name).toBe('Fix Potholes');
    expect(result).toMatchObject({ ok: true, createdAs: 'anonymous', slug: 'fix-potholes' });
  });

  it('uses the owner agent key only for the configured owner', async () => {
    const calls = mockFetch(200, created('agent_key'));
    const result = await toolWitCreateTracker(OWNER, { name: 'Fix Potholes', anonymous: false });
    expect(calls[0].headers['X-Agent-Key']).toBe('wit_owner_key');
    expect(result).toMatchObject({ ok: true, createdAs: 'Jacob (authenticated)' });
  });

  it('lets the owner explicitly create anonymously', async () => {
    const calls = mockFetch(200, created('anonymous'));
    await toolWitCreateTracker(OWNER, { name: 'Fix Potholes', anonymous: true });
    expect(calls[0].headers['X-Agent-Key']).toBeUndefined();
  });

  it.each([undefined, '', '   '])('refuses owner creation when the agent key is %j', async (key) => {
    if (key === undefined) delete process.env.WIT_AGENT_KEY;
    else process.env.WIT_AGENT_KEY = key;
    const calls = mockFetch(200, created('anonymous'));
    const error = { error: 'Owner tracker creation is not configured on the server; ask to create it anonymously instead.' };
    expect(resolveWitTrackerCreationMode(OWNER, false)).toEqual(error);
    expect(await toolWitCreateTracker(OWNER, { name: 'Fix Potholes', anonymous: false })).toEqual(error);
    expect(calls).toHaveLength(0);
  });

  it('allows anonymous creation without an owner agent key', async () => {
    delete process.env.WIT_AGENT_KEY;
    const calls = mockFetch(200, created('anonymous'));
    expect(resolveWitTrackerCreationMode(OWNER, true)).toEqual({ mode: 'anonymous' });
    for (const [userId, anonymous] of [[OWNER, true], [user(), false]] as const) {
      expect(await toolWitCreateTracker(userId, { name: 'Fix Potholes', anonymous })).toMatchObject({ ok: true, createdAs: 'anonymous' });
    }
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers['X-Agent-Key'] === undefined)).toBe(true);
  });

  it('preserves successful creation while reporting failed ownership assignment', async () => {
    const warning = 'Could not assign tracker owner';
    mockFetch(200, { ...created('agent_key'), ownership_warning: warning });
    expect(await toolWitCreateTracker(OWNER, { name: 'Fix Potholes', anonymous: false })).toMatchObject({
      ok: true,
      url: 'https://worldissuetracker.com/tracker/fix-potholes',
      ownership_warning: warning,
      note: 'Tracker created, but ownership assignment failed; do not describe it as owned by the account.',
    });
  });

  it('never retries an owner failure anonymously', async () => {
    const calls = mockFetch(401, { code: 'invalid_agent_key', message: 'X-Agent-Key did not resolve' });
    const result = await toolWitCreateTracker(OWNER, { name: 'Fix Potholes', anonymous: false });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ error: 'Failed to create tracker' });
  });

  it('surfaces exact duplicates so the assistant reuses the existing board', async () => {
    mockFetch(409, {
      success: false,
      code: 'tracker_name_exists',
      tracker: { id: 't0', name: 'Fix Potholes', slug: 'fix-potholes', url: 'https://worldissuetracker.com/tracker/fix-potholes' },
    });
    const result = await toolWitCreateTracker(user(), { name: 'fix potholes', anonymous: false });
    expect(result).toMatchObject({ duplicate: true, existing: { slug: 'fix-potholes' } });
  });

  it('reports WIT rate limiting', async () => {
    mockFetch(429, { code: 'rate_limited', retry_after_seconds: 120 });
    const result = await toolWitCreateTracker(user(), { name: 'Fix Potholes', anonymous: false });
    expect(result).toMatchObject({ retryAfterSeconds: 120 });
  });

  it('requires a name and only sends source_url_is_default with a source_url', async () => {
    const calls = mockFetch(200, created('anonymous'));
    expect(await toolWitCreateTracker(user(), { name: '   ', anonymous: false })).toEqual({ error: 'name is required' });
    await toolWitCreateTracker(user(), { name: 'Board', sourceUrlIsDefault: true, anonymous: false });
    expect(calls[0].body.source_url_is_default).toBeUndefined();
  });
});
