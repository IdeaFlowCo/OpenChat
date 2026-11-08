import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Request, Response as ExpressResponse } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../mcp-server/src/server.js';
import { contactInput, stateInput } from '../src/services/overlay/contacts.js';

const graph = vi.hoisted(() => ({ importContactSource: vi.fn(), importContactSources: vi.fn(), savePeopleState: vi.fn(), listThings: vi.fn(), updatePersonCard: vi.fn() }));
vi.mock('../src/services/privateGraph.js', async () => ({ ...await vi.importActual('../src/services/privateGraph.js'), ...graph }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: async () => ({ records: [{ get: () => 'synthetic-owner' }] }), close: async () => {} }) }) }));
import privateRoutes from '../src/routes/privateGraph.js';
import { connectorOperationGuard, handleIdeaflowConnector } from '../src/routes/ideaflowConnector.js';

const opaque = { schemaVersion: 1, author: 'original', source: 'original', fromMe: true, recordedBy: 'unchanged',
  emails: [{ label: 'work', value: 'synthetic@example.test' }], phones: [{ label: 'mobile', value: '+15555550100' }],
  future: { ownerKey: 'opaque-data-only', text: 'kept verbatim', aliases: ['Alex', 'Ａlex'] } };
const card = { source: ' Synthetic Address Book ', sourceId: 'card/001', name: 'Alex Example', data: opaque };
const by = { author: 'agent:Synthetic client', source: 'connector', assertion: 'stated' };
const secret = 'synthetic-test-only-connector-secret-32-bytes';

// No socket or database substitute: this exercises the actual MCP SDK, hub,
// router and auth middleware, stopping at an explicitly mocked graph service.
// Body-parser and persistent-store behavior require their integration suites.
function routeFetch(input: string | URL | globalThis.Request, init: RequestInit = {}): Promise<globalThis.Response> {
  const url = new URL(String(input));
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = { method: init.method ?? 'GET', url: url.pathname.replace(/^\/api\/private/, '') + url.search,
      originalUrl: url.pathname + url.search, headers, body: init.body ? JSON.parse(String(init.body)) : undefined,
      query: Object.fromEntries(url.searchParams), socket: { localPort: 9876 } } as unknown as Request;
    let status = 200;
    const res = { status(code: number) { status = code; return this; },
      json(value: unknown) { resolve(new globalThis.Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })); return this; },
      setHeader() {} } as unknown as ExpressResponse;
    const done = (error?: unknown) => error ? reject(error) : reject(new Error(`Unhandled test route ${req.originalUrl}`));
    connectorOperationGuard(req, res, error => {
      if (error) reject(error);
      else (privateRoutes as unknown as { handle: (req: Request, res: ExpressResponse, next: typeof done) => void }).handle(req, res, done);
    });
  });
}

async function hub(name: string, args: Record<string, unknown>, scope = 'openchat:read openchat:write') {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://chat.ideaflow.app/mcp',
    identity_issuer: 'https://id.ideaflow.app/api/auth', sub: 'synthetic-subject', scope, client: 'Synthetic client',
    iat: now, exp: now + 60, jti: randomUUID(), body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url');
  const token = `${header}.${claims}.${createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url')}`;
  let status = 200, value: any;
  const res = { setHeader() {}, status(code: number) { status = code; return this; }, json(json: unknown) { value = json; return this; } } as unknown as ExpressResponse;
  await handleIdeaflowConnector({ body, headers: { authorization: `Bearer ${token}` }, socket: { localPort: 9876 } } as Request, res);
  return { status, value };
}

async function mcp(run: (client: Client) => Promise<void>, apiKey: string | null = 'oc_synthetic_test_only') {
  const server = buildServer({ baseUrl: 'https://synthetic.invalid', apiKey: apiKey ?? undefined });
  const client = new Client({ name: 'contacts-adapter-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(a); await client.connect(b); await run(client); }
  finally { await client.close(); await server.close(); }
}
const payload = (result: any) => JSON.parse(result.content[0].text);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('contacts executable adapter contracts', () => {
  it('preserves supported and future JSON fields and exact source identifiers at the canonical input interface', () => {
    const parsed = contactInput(card);
    expect(parsed).toMatchObject(card);
    expect(parsed.data).not.toBe(opaque);
    expect(contactInput({ ...card, source: card.source.trim() }).sourceKey).not.toBe(parsed.sourceKey);
    expect(() => contactInput({ ...card, ownerKey: 'spoof' })).toThrow();
    const state = { operationId: 'synthetic-operation', expectedRevision: 0, payload: opaque };
    expect(stateInput(state, by)).toMatchObject({ ...state, provenance: by });
    expect(() => stateInput({ ...state, author: 'owner' }, by)).toThrow();
  });

  it('round-trips cursors, totals beyond 5000 and batched detail fields through the real MCP tool', async () => {
    const first = { things: [{ id: 'synthetic-person-1', name: card.name, kind: 'person', card: { important: true },
      peopleState: { revision: 3, payload: opaque }, notes: [{ text: 'Synthetic note' }], links: [], contactSources: [card] }], nextCursor: 'scoped_cursor', total: 5007 };
    const last = { things: [{ id: 'synthetic-person-5007', kind: 'person', name: 'Last synthetic person' }], nextCursor: null, total: 5007 };
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      const request = new URL(url); requests.push({ method: options.method, path: request.pathname, query: Object.fromEntries(request.searchParams) });
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer oc_synthetic_test_only');
      return new Response(JSON.stringify(request.searchParams.has('after') ? last : first));
    }));
    await mcp(async client => {
      const firstResult = payload(await client.callTool({ name: 'oc_list_private_things', arguments: { kind: 'person', query: 'Alex', limit: 73, details: true } }));
      expect(firstResult).toEqual(first);
      expect(payload(await client.callTool({ name: 'oc_list_private_things', arguments: { kind: 'person', query: 'Alex', limit: 73, details: true, after: firstResult.nextCursor } }))).toEqual(last);
      expect(requests).toEqual([
        { method: 'GET', path: '/api/private/things', query: { q: 'Alex', kind: 'person', limit: '73', details: 'true' } },
        { method: 'GET', path: '/api/private/things', query: { q: 'Alex', kind: 'person', after: 'scoped_cursor', limit: '73', details: 'true' } },
      ]);
    });
  });

  it('forwards single/batch imports and People operations through MCP without rewriting opaque JSON', async () => {
    const seen: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      seen.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(String(options.body)) });
      return new Response(JSON.stringify({ received: seen.at(-1)!.body }));
    }));
    await mcp(async client => {
      expect(payload(await client.callTool({ name: 'oc_import_contact_source', arguments: card })).received).toEqual(card);
      expect(payload(await client.callTool({ name: 'oc_import_contact_sources', arguments: { cards: [card, { ...card, sourceId: 'card/002' }] } })).received.cards).toHaveLength(2);
      const state = { thingId: 'synthetic-person', operationId: 'synthetic-operation', expectedRevision: 3, payload: opaque };
      expect(payload(await client.callTool({ name: 'oc_save_people_state', arguments: state })).received).toEqual({ operationId: state.operationId, expectedRevision: 3, payload: opaque });
      expect(seen.map(({ path, method }) => [method, path])).toEqual([
        ['POST', '/api/private/contact-sources'], ['POST', '/api/private/contact-source-batches'], ['PUT', '/api/private/things/synthetic-person/people-state'],
      ]);
    });
  });

  it('rejects malformed MCP batches and operations before fetching and surfaces server failures', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'state_conflict' }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    await mcp(async client => {
      for (const request of [
        { name: 'oc_import_contact_sources', arguments: { cards: Array(26).fill(card) } },
        { name: 'oc_save_people_state', arguments: { thingId: 'synthetic-person', expectedRevision: 0, payload: opaque } },
        { name: 'oc_list_private_things', arguments: { limit: 101 } },
      ]) expect((await client.callTool(request)).isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      const failed: any = await client.callTool({ name: 'oc_save_people_state', arguments: { thingId: 'synthetic-person', operationId: 'synthetic-op', expectedRevision: 0, payload: opaque } });
      expect(failed.isError).toBe(true); expect(failed.content[0].text).toContain('state_conflict');
    });
    fetch.mockClear();
    await mcp(async client => {
      expect((await client.callTool({ name: 'oc_import_contact_source', arguments: card })).isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    }, null);
  });

  it('dispatches hub source/state/card writes with verified actor and owner, preserving opaque data and page options', async () => {
    vi.stubEnv('IDEAFLOW_CONNECTOR_SECRET', secret);
    vi.stubGlobal('fetch', routeFetch);
    graph.importContactSource.mockImplementation(async (_owner, input) => ({ entity: { id: 'synthetic-person', name: input.name }, created: true }));
    graph.importContactSources.mockResolvedValue({ results: [{ index: 0, id: 'synthetic-person', created: false, unchanged: true }] });
    graph.savePeopleState.mockImplementation(async (_owner, _id, input, actor) => ({ revision: 1, payload: input.payload, ...actor }));
    graph.updatePersonCard.mockResolvedValue({ important: true });
    graph.listThings.mockResolvedValue({ things: [], total: 5007, nextCursor: 'scoped_cursor' });
    const imported = await hub('oc_import_contact_source', card);
    expect(imported.status).toBe(200); expect(imported.value.result.isError).toBeUndefined();
    expect(graph.importContactSource).toHaveBeenCalledWith('synthetic-owner', card, by);
    const batch = await hub('oc_import_contact_sources', { cards: [card] });
    expect(payload(batch.value.result).results[0].unchanged).toBe(true);
    expect(graph.importContactSources).toHaveBeenCalledWith('synthetic-owner', [card], by);
    const state = { operationId: 'synthetic-operation', expectedRevision: 0, payload: opaque };
    const saved = await hub('oc_save_people_state', { thingId: 'synthetic-person', ...state });
    expect(payload(saved.value.result)).toEqual({ revision: 1, payload: opaque, ...by });
    expect(graph.savePeopleState).toHaveBeenCalledWith('synthetic-owner', 'synthetic-person', state, by);
    const legacy = await hub('oc_set_person_private', { userId: 'synthetic-target', important: true });
    expect(legacy.value.result.isError).toBeUndefined();
    expect(graph.updatePersonCard).toHaveBeenCalledWith('synthetic-owner', 'synthetic-target', { important: true }, by);
    const page = await hub('oc_list_private_things', { kind: 'person', query: 'Alex', after: 'scoped_cursor', details: true, limit: 73 });
    expect(payload(page.value.result).total).toBe(5007);
    expect(graph.listThings).toHaveBeenCalledWith('synthetic-owner', 'Alex', 'person', { after: 'scoped_cursor', details: 'true', limit: '73' });
    expect((await hub('oc_import_contact_source', { ...card, ownerKey: 'spoof' })).status).toBe(400);
    expect((await hub('oc_save_people_state', { thingId: 'synthetic-person', ...state, author: 'owner' })).status).toBe(400);
    expect((await hub('oc_import_contact_source', card, 'openchat:read')).status).toBe(403);
    const evidence = JSON.stringify({
      scope: 'Synthetic adapter transcript: actual hub signatures, operation guard, REST router and actor middleware; graph service mocked. No database persistence or real socket demonstrated.',
      sourceRequest: card, sourceResponse: payload(imported.value.result), batchResponse: payload(batch.value.result),
      stateResponse: payload(saved.value.result), legacyCardResponse: payload(legacy.value.result), pageResponse: payload(page.value.result),
      graphActor: by, graphOwner: 'synthetic-owner', rejectedOwnerSpoof: 400, rejectedActorSpoof: 400, rejectedReadOnlyWrite: 403,
    }, null, 2);
    if (process.env.CONTACTS_ADAPTER_EVIDENCE === '-') console.log(evidence);
    else if (process.env.CONTACTS_ADAPTER_EVIDENCE) writeFileSync(process.env.CONTACTS_ADAPTER_EVIDENCE, evidence);
  });
});
