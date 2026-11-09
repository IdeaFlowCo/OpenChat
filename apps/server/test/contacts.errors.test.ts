import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ initialize: vi.fn(async () => {}), savePeopleState: vi.fn() }));
vi.mock('../src/services/overlay/store.js', async () => ({
  ...await vi.importActual('../src/services/overlay/store.js'),
  OverlayStore: class { initialize = store.initialize; savePeopleState = store.savePeopleState; },
}));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({
  run: async () => ({ records: [{ get: () => null }] }), close: async () => {},
}) }) }));
vi.mock('../src/middleware/resolveActor.js', () => ({ resolveActor: (req: any, _res: any, next: () => void) => { req.user = { userId: 'synthetic-owner' }; next(); } }));
import { OverlayError } from '../src/services/overlay/contract.js';
import routes from '../src/routes/privateGraph.js';
import { buildServer } from '../../mcp-server/src/server.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['state_conflict', 'operation_id_reused', 'legacy_operation_requires_reconciliation'])('preserves %s and safe recovery details through the service, REST and MCP', async code => {
  store.savePeopleState.mockRejectedValue(new OverlayError(409, code, { revision: 7, payload: 'private synthetic data', message: 'untrusted detail' }));
  const app = express().use(express.json()).use('/api/private', routes);
  const operation = { operationId: 'synthetic-op', expectedRevision: 0, payload: { schemaVersion: 1 } };
  const response = await request(app).put('/api/private/things/synthetic-person/people-state').send(operation);
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: expect.any(String), code, revision: 7 });
  expect(response.body.error).not.toBe('Check what you entered and try again');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status })));
  const server = buildServer({ baseUrl: 'https://synthetic.invalid', apiKey: 'oc_synthetic' });
  const client = new Client({ name: 'conflict-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result: any = await client.callTool({ name: 'oc_save_people_state', arguments: { thingId: 'synthetic-person', ...operation } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`"code":"${code}"`);
    expect(result.content[0].text).toContain('"revision":7');
    expect(result.content[0].text).not.toContain('private synthetic data');
  } finally { await client.close(); await server.close(); }
});
