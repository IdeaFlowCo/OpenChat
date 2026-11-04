import { createHash, createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ linked: true, feed: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: async () => ({ records: state.linked ? [{ get: () => 'viewer-owner' }] : [] }), close: async () => {} }) }) }));
vi.mock('../src/services/agentSocialLayer.js', async () => ({ ...await vi.importActual('../src/services/agentSocialLayer.js'), listStoryFeed: state.feed }));
import { handleIdeaflowConnector, connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import socialRoutes from '../src/routes/agentSocialLayer.js';
const secret = 'fictional-story-connector-secret-at-least-32-bytes';
function assertion(body: string, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://chat.ideaflow.app/mcp', identity_issuer: 'https://id.ideaflow.app/api/auth', sub: 'fictional-subject', scope, iat: now, exp: now + 45, jti: randomUUID(), body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url');
  return `${header}.${claims}.${createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url')}`;
}
describe('People shared ask feed through the connector', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    process.env.IDEAFLOW_CONNECTOR_SECRET = secret;
    const app = express(); app.post('/api/connector/mcp', express.raw({ type: 'application/json' }), handleIdeaflowConnector);
    app.use(express.json()); app.use('/api', connectorOperationGuard); app.use('/api', socialRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { delete process.env.IDEAFLOW_CONNECTOR_SECRET; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => { state.linked = true; state.feed.mockReset().mockResolvedValue([]); });
  async function rpc(method: string, params: unknown, scope = 'openchat:read') {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return fetch(`${base}/api/connector/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${assertion(body, scope)}` }, body });
  }
  it('advertises a read-only feed without adding any write grant', async () => {
    const result = await (await rpc('tools/list', {})).json();
    const tool = result.result.tools.find((t: { name: string }) => t.name === 'oc_list_story_feed');
    expect(tool).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, securitySchemes: [{ scopes: ['openchat:read'] }] });
  });
  it('uses the exact linked viewer, optional author and existing human redaction route', async () => {
    const visible = { id: 'visible-story', text: 'A community workshop space', author: { id: 'author-1', name: 'Fictional author' }, createdAt: '2026-11-04T10:00:00Z', storyExpiresAt: '2027-01-01T00:00:00Z' };
    state.feed.mockResolvedValue([{ ...visible, structuredTerms: { privateCanary: 'agent-search-only' }, searchExpiresAt: 'private-search-expiry' }]);
    const response = await rpc('tools/call', { name: 'oc_list_story_feed', arguments: { authorId: 'author-1' } });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(JSON.parse(result.result.content[0].text)).toEqual({ stories: [visible] });
    expect(state.feed).toHaveBeenCalledWith('viewer-owner', 'author-1');
    expect(JSON.stringify(result)).not.toContain('agent-search-only');
  });
  it('refuses caller-selected viewers, private-data switches and wrong scopes', async () => {
    for (const args of [{ viewerId: 'another-owner' }, { includePrivate: true }, { authorId: '' }, { authorId: ['one', 'two'] }]) {
      expect((await rpc('tools/call', { name: 'oc_list_story_feed', arguments: args })).status).toBe(400);
    }
    expect((await rpc('tools/call', { name: 'oc_list_story_feed', arguments: {} }, 'openchat:write')).status).toBe(403);
    state.linked = false;
    expect((await rpc('tools/call', { name: 'oc_list_story_feed', arguments: {} })).status).toBe(409);
    expect(state.feed).not.toHaveBeenCalled();
  });
  it('returns only the audience-filtered service result and preserves empty feeds', async () => {
    const result = await (await rpc('tools/call', { name: 'oc_list_story_feed', arguments: {} })).json();
    expect(JSON.parse(result.result.content[0].text)).toEqual({ stories: [] });
    expect(state.feed).toHaveBeenCalledWith('viewer-owner', null);
  });
});
