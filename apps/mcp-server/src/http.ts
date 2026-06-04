#!/usr/bin/env node
/**
 * OpenChat MCP Server — Streamable HTTP entrypoint.
 *
 * Exposes the same tool set as `src/index.ts` but over the Streamable HTTP
 * transport that Cursor and Claude Code's HTTP connector expect. Each
 * incoming request reads its own API key from headers so no key leaks
 * across concurrent users.
 *
 * Auth model (per-request key pickup, checked in order):
 *   1. Authorization: Bearer <key>   — primary shape
 *   2. x-api-key: <key>              — convenience header
 *   3. ?key=<key>                    — query-param fallback
 *   4. OPENCHAT_API_KEY env var      — process-wide fallback (single-tenant)
 *
 * Env vars:
 *   PORT               HTTP port to bind (default: 8484)
 *   HOST               Interface to bind (default: 0.0.0.0)
 *   OPENCHAT_BASE_URL  Upstream OpenChat URL (default: https://chat.globalbr.ai)
 *   OPENCHAT_API_KEY   Optional fallback key
 *
 * Endpoints:
 *   POST /mcp          Streamable HTTP MCP (JSON-RPC in, SSE or JSON out)
 *   GET  /mcp          SSE transport support
 *   DELETE /mcp        Session teardown
 *   GET  /healthz      Liveness probe → {status:"ok"}
 *
 * Client usage (Cursor):
 *   In .cursor/mcp.json:
 *     { "openchat": { "url": "http://localhost:8484/mcp", "headers": { "Authorization": "Bearer oc_…" } } }
 */

import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getConfig } from './api.js';
import { buildServer, VERSION } from './server.js';

const DEFAULT_PORT = 8484;
const DEFAULT_HOST = '0.0.0.0';
const MAX_BODY_BYTES = '1mb';

function pickApiKey(req: Request): string | undefined {
  // 1. Authorization: Bearer <key>
  const authz = req.header('authorization');
  if (authz && /^bearer\s+/i.test(authz)) {
    return authz.replace(/^bearer\s+/i, '').trim();
  }
  // 2. x-api-key header
  const header = req.header('x-api-key');
  if (header?.trim()) return header.trim();
  // 3. ?key= query param
  const rawQueryKey = req.query.key;
  const queryKey = typeof rawQueryKey === 'string' ? rawQueryKey.trim() : undefined;
  if (queryKey) return queryKey;
  // 4. Process-wide fallback
  return process.env.OPENCHAT_API_KEY || undefined;
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const reqId = randomUUID();
  const baseUrl = (
    process.env.OPENCHAT_BASE_URL || 'https://chat.globalbr.ai'
  ).replace(/\/+$/, '');
  const apiKey = pickApiKey(req);

  const config = { baseUrl, apiKey };
  const server = buildServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[openchat-mcp-http] ${reqId} handler error:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
          data: err instanceof Error ? err.message : String(err),
        },
        id: null,
      });
    }
  }
}

function main(): void {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  const { baseUrl, apiKey: envKey } = getConfig();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send(
        `OpenChat MCP Server (HTTP) v${VERSION}\n` +
          `MCP endpoint: POST /mcp  (Streamable HTTP transport)\n` +
          `Auth: Authorization: Bearer <openchat api key>\n`
      );
  });

  app.post('/mcp', handleMcpRequest);
  app.get('/mcp', handleMcpRequest);
  app.delete('/mcp', handleMcpRequest);

  app.listen(port, host, () => {
    console.error(
      `[openchat-mcp-http] v${VERSION} listening on http://${host}:${port}/mcp → ${baseUrl}` +
        (envKey ? ' (env fallback api key set)' : ' (no env fallback; clients must pass their own key)')
    );
  });
}

main();
