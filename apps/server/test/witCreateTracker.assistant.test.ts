import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Real assistant loop and HTTP adapter, with a scripted model, conversation
// DB double, and isolated WIT HTTP contract fixture. Never writes production.
const h = vi.hoisted(() => ({ create: vi.fn(), replies: [] as string[], text: 'Create a Community Repairs board' }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.create }; } }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({
  close: async () => {},
  run: async (_query: string, params: Record<string, unknown>) => {
    if ('content' in params) { h.replies.push(String(params.content)); return { records: [] }; }
    const row: Record<string, unknown> = { content: h.text, senderId: 'human', senderName: 'User' };
    return { records: [{ get: (key: string) => row[key] ?? null }] };
  },
}) }) }));
const OWNER = 'integration-owner';
const requests: Array<{ path: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
const evidence: unknown[] = [];
let server: Server;
let assistant: typeof import('../src/services/assistant.js');
let external: typeof import('../src/services/externalActions.js');
let status = 200;
let failure: Record<string, unknown> = {};
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, headers: { ...req.headers }, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/get-trackers')) { res.end(JSON.stringify({ trackers: [] })); return; }
    res.statusCode = status;
    res.end(JSON.stringify(status === 200 ? {
      success: true, creator: { kind: req.headers['x-agent-key'] ? 'agent_key' : 'anonymous' },
      tracker: { name: body.name, slug: 'community-repairs', url: 'https://worldissuetracker.com/tracker/community-repairs' },
    } : failure));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('WIT_API_BASE', `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  vi.stubEnv('WIT_PUBLIC_API_BASE', `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-model-key');
  vi.stubEnv('OPENCHAT_OWNER_USER_ID', OWNER);
  vi.stubEnv('WIT_AGENT_KEY', 'test-owner-key');
  vi.stubEnv('WIT_ANON_KEY', 'test-public-anon-key');
  assistant = await import('../src/services/assistant.js');
  external = await import('../src/services/externalActions.js');
});
beforeEach(() => { requests.length = 0; h.replies.length = 0; h.create.mockReset(); status = 200; });
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  vi.unstubAllEnvs();
  if (process.env.WIT_TEST_EVIDENCE_DIR) {
    await mkdir(process.env.WIT_TEST_EVIDENCE_DIR, { recursive: true });
    await writeFile(`${process.env.WIT_TEST_EVIDENCE_DIR}/wit-assistant-http-transcript.json`, JSON.stringify({
      scope: 'Real OpenChat assistant loop and HTTP adapter; scripted model, conversation DB double, local WIT contract fixture. No production writes or live-model evaluation.', scenarios: evidence,
    }, null, 2));
  }
});
async function turn(userId: string, input: Record<string, unknown>, text = 'Create a Community Repairs board') {
  h.text = text;
  let result: any;
  h.create.mockImplementationOnce(async (request: any) => {
    const tool = request.tools.find((t: any) => t.name === 'wit_create_tracker');
    expect(tool).toBeDefined();
    expect(tool.input_schema.properties.unlisted).toBeUndefined();
    expect(tool.input_schema.properties.nudge).toBeUndefined();
    // This is the final emitted tool interface delivered to the model.
    expect(tool.description).toContain('wit_list_trackers');
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'create-board', name: tool.name, input }] };
  }).mockImplementationOnce(async (request: any) => {
    result = JSON.parse(request.messages.at(-1).content[0].content);
    // Relay observed results verbatim; do not pretend to evaluate an LLM.
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  await assistant.runAssistantTurn({ userId, conversationId: 'fixture-assistant-dm' });
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(h.replies.at(-1)).toBe(JSON.stringify(result));
  h.create.mockClear();
  return result;
}
describe('WIT tracker creation through the assistant', () => {
  it.each([
    ['non-owner with forged model owner id', 'other-user', false, 'anonymous'],
    ['authenticated owner', OWNER, false, 'Jacob (authenticated)'],
    ['owner explicitly anonymous', OWNER, true, 'anonymous'],
    ['owner prefix is not owner', `${OWNER}-extra`, false, 'anonymous'],
  ])('%s: confirms before creating with trusted identity', async (scenario, userId, anonymous, createdAs) => {
    const input = { name: ' Community Repairs ', anonymous, userId: OWNER, unlisted: true, nudge: true };
    const first = await turn(userId, input);
    expect(first).toMatchObject({ needsConfirmation: true, wouldCreateAs: createdAs });
    expect(requests).toHaveLength(0);
    const second = await turn(userId, { ...input, confirm: true }, 'Yes, create it.');
    expect(second).toMatchObject({ ok: true, createdAs, url: 'https://worldissuetracker.com/tracker/community-repairs' });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers['x-wit-client']).toBe('openchat');
    expect(requests[0].headers.apikey).toBe('test-public-anon-key');
    expect(requests[0].headers['x-agent-key']).toBe(createdAs === 'anonymous' ? undefined : 'test-owner-key');
    expect(requests[0].headers.authorization).toBe(createdAs === 'anonymous' ? undefined : 'Bearer test-public-anon-key');
    expect(requests[0].body).toEqual({ name: 'Community Repairs' });
    evidence.push({ scenario, first, confirmed: second, httpRequests: [...requests] });
  });
  it.each([
    [401, { code: 'invalid_agent_key', message: 'Owner key rejected' }, OWNER, { error: 'Failed to create tracker' }],
    [401, { code: 'UNAUTHORIZED_NO_AUTH_HEADER' }, 'anonymous-before-deployment', { error: 'Failed to create tracker' }],
    [409, { code: 'tracker_name_exists', tracker: { name: 'Community Repairs', slug: 'community-repairs', url: 'https://worldissuetracker.com/tracker/community-repairs' } }, 'duplicate-name', { duplicate: true, existing: { slug: 'community-repairs' } }],
    [409, { code: 'tracker_slug_exists', tracker: { name: 'Community Repairs', slug: 'community-repairs', url: 'https://worldissuetracker.com/tracker/community-repairs' } }, 'duplicate-slug', { duplicate: true, existing: { slug: 'community-repairs' } }],
    [429, { code: 'rate_limited', retry_after_seconds: 120 }, 'rate-limited', { retryAfterSeconds: 120 }],
  ])('relays WIT %s without identity fallback', async (httpStatus, response, userId, expected) => {
    status = httpStatus;
    failure = response;
    const result = await turn(userId, { name: 'Community Repairs', confirm: true });
    expect(result).toMatchObject(expected);
    expect(requests).toHaveLength(1);
    evidence.push({ scenario: userId, httpStatus, result, httpRequests: [...requests] });
  });
  it('shares the 30/hour external-write budget and resets after an hour', async () => {
    const userId = 'shared-budget-user';
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (let i = 0; i < 29; i++) await external.toolWitCreateIssue(userId, { title: 'Related issue', anonymous: true });
      const last = await turn(userId, { name: 'Community Repairs', confirm: true });
      expect(last).toMatchObject({ ok: true });
      const blocked = await turn(userId, { name: 'Another Board', confirm: true });
      expect(blocked).toEqual({ error: 'External write rate limit reached — try again later.' });
      expect(requests).toHaveLength(30);
      clock.mockReturnValue(now + 3_600_001);
      const reset = await turn(userId, { name: 'Another Board', confirm: true });
      expect(reset).toMatchObject({ ok: true });
      expect(requests).toHaveLength(31);
      evidence.push({ scenario: 'shared 30/hour write limit', lastAllowed: last, blocked, afterWindow: reset, upstreamRequestCount: requests.length });
    } finally { clock.mockRestore(); }
  });
  it('sends the informational client header on tracker discovery too', async () => {
    await external.toolWitListTrackers('Community');
    expect(requests[0].headers['x-wit-client']).toBe('openchat');
    expect(requests[0].headers['x-agent-key']).toBeUndefined();
  });
});
