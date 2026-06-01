#!/usr/bin/env node
/**
 * OpenChat MCP Server — stdio entrypoint.
 *
 * Thin wrapper around the shared `buildServer()` factory in `./server.ts`.
 * All tool registrations live there so stdio and HTTP transports expose
 * an identical surface.
 *
 * Transport: stdio (the universal MCP transport for Claude Desktop).
 *
 * Env vars:
 *   OPENCHAT_API_KEY    Bearer token (starts `oc_` for agent keys, or a JWT)
 *   OPENCHAT_BASE_URL   default https://chat.globalbr.ai
 *
 * Credentials file (fallback if env vars are unset):
 *   ~/.openchat/credentials.json  — { "apiKey": "oc_…", "baseUrl": "https://…" }
 *
 * Note: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getConfig } from './api.js';
import { buildServer, VERSION } from './server.js';

async function main() {
  const config = getConfig();
  console.error(
    `[openchat-mcp] v${VERSION} → ${config.baseUrl} ${
      config.apiKey ? '(authenticated)' : '(no api key — most tools will fail)'
    }`
  );

  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[openchat-mcp] listening on stdio');
}

main().catch((e) => {
  console.error('[openchat-mcp] fatal:', e);
  process.exit(1);
});
