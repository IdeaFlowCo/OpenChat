import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../mcp-server/src/server.js';
afterEach(() => vi.unstubAllGlobals());
it('exposes additive shared-content reads over MCP using GET and existing key credentials', async () => {
  const page = { items: [{ id: 'shared', visibility: 'conversation', provenance: 'message_capture' }] };
  const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
  const server = buildServer({ baseUrl: 'https://fixture.invalid', apiKey: 'oc_synthetic' });
  const client = new Client({ name: 'test', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = await client.listTools(); expect(tools.tools.find(t => t.name === 'oc_list_conversation_content')?.annotations?.readOnlyHint).toBe(true); expect(tools.tools.some(t => t.name === 'oc_get_messages')).toBe(true);
    const result: any = await client.callTool({ name: 'oc_list_conversation_content', arguments: { conversationId: 'room', filter: 'stream', search: 'planning', cursor: 'cursor', limit: 1 } });
    expect(JSON.parse(result.content[0].text)).toEqual(page); expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options]: any = fetch.mock.calls[0]; expect(new URL(url).pathname).toBe('/api/chat/conversations/room/content'); expect(new URL(url).searchParams.get('cursor')).toBe('cursor'); expect(options.method).toBe('GET'); expect(options.headers.Authorization).toBe('Bearer oc_synthetic');
  } finally { await client.close(); await server.close(); }
});
it('rejects unauthenticated MCP content reads without contacting any endpoint', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const server = buildServer({ baseUrl: 'https://fixture.invalid' }); const client = new Client({ name: 'test', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(a); await client.connect(b); const result = await client.callTool({ name: 'oc_list_conversation_content', arguments: { conversationId: 'room' } }); expect(result.isError).toBe(true); expect(fetch).not.toHaveBeenCalled(); }
  finally { await client.close(); await server.close(); }
});
