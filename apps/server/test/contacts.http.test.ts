import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../mcp-server/src/http.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('dispatches a maximal supported source batch over the actual MCP HTTP transport', async () => {
  vi.stubEnv('OPENCHAT_BASE_URL', 'https://synthetic.invalid');
  const cards = Array.from({ length: 25 }, (_, index) => ({ source: 'Synthetic', sourceId: String(index), name: 'Synthetic person', data: { schemaVersion: 1, notes: 'x'.repeat(260000) } }));
  const upstream = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).cards).toEqual(cards);
    return new Response(JSON.stringify({ results: cards.map((_, index) => ({ index, id: `synthetic-${index}`, created: true })) }));
  });
  vi.stubGlobal('fetch', upstream);
  const response = await request(createHttpApp()).post('/mcp')
    .set('Authorization', 'Bearer oc_synthetic').set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oc_import_contact_sources', arguments: { cards } } });
  expect(response.status).toBe(200);
  expect(response.body.result.isError).toBeUndefined();
  expect(JSON.parse(response.body.result.content[0].text).results).toHaveLength(25);
  expect(upstream).toHaveBeenCalledOnce();
});

it('rejects oversized MCP envelopes before tool dispatch', async () => {
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  const response = await request(createHttpApp()).post('/mcp').set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oc_import_contact_sources', arguments: { padding: 'x'.repeat(7 * 1024 * 1024) } } });
  expect(response.status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
