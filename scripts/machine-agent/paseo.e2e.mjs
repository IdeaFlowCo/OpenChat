import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';
import jwt from 'jsonwebtoken';
import { Authority } from './authority.mjs';
import { runReviewed, connectLocal } from './paseo.mjs';
import { seal, open, identity, hex, parseOffer } from '../../apps/mobile/src/services/machineAgent/channel.mjs';
import { attachMachineRelay } from '../../apps/server/src/websocket/machineRelay.ts';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';

const install = process.env.PASEO_TEST_INSTALL,
  source = process.env.PASEO_TEST_SOURCE;
if (!install?.startsWith('/') || !source?.startsWith('/'))
  throw Error('Set absolute PASEO_TEST_INSTALL and PASEO_TEST_SOURCE paths.');
const p = install;
const d = mkdtempSync(join(tmpdir(), 'openchat-paseo-test-')),
  workspace = join(d, 'workspace');
mkdirSync(workspace);
process.env.TMPDIR = d;
const fixture = execFileSync(
  'git',
  [
    '-C',
    source,
    'show',
    '2273c4d67674d05ba4915dccfc6ba6eed1ed75a6:packages/server/src/server/test-utils/fake-agent-client.ts',
  ],
  { encoding: 'utf8' },
);
await build({
  stdin: { contents: fixture, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: {
    '@getpaseo/protocol/tool-name-normalization': join(p, 'packages/protocol/dist/tool-name-normalization.js'),
  },
  outfile: join(d, 'fixture.mjs'),
});
const { createTestAgentClients } = await import(join(d, 'fixture.mjs'));
const { createPaseoDaemon } = await import(p + '/packages/server/dist/server/server/bootstrap.js');
const pino = createRequire(p + '/packages/server/package.json')('pino');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const userToken = jwt.sign({ userId: 'synthetic', email: 'test@example.invalid' }, process.env.JWT_SECRET);
const server = createServer();
const relay = new Server(server);
attachMachineRelay(relay);
let calls = 0;
const fake = createTestAgentClients({
  onStartTurn() {
    calls++;
  },
}).codex;
const port = randomInt(7200, 9999),
  relayPort = randomInt(7000, 7199);
const daemon = await createPaseoDaemon(
  {
    listen: '127.0.0.1:' + port,
    paseoHome: d,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    mcpInjectIntoAgents: false,
    pluginsEnabled: false,
    browserToolsEnabled: false,
    mcpDebug: false,
    staticDir: d,
    agentClients: { codex: fake },
    agentStoragePath: join(d, 'agents'),
    relayEnabled: false,
    metadataGeneration: { providers: [] },
  },
  pino({ level: 'silent' }),
);
let client,
  peers = [],
  db;
try {
  await daemon.start();
  process.env.OPENCHAT_PASEO_PORT = String(port);
  process.env.OPENCHAT_PASEO_SDK = p + '/packages/client/dist/index.js';
  client = await connectLocal();
  const ref = await client.agents.create({
    config: { provider: 'codex/mock-model', modeId: 'auto' },
    cwd: workspace,
    title: 'Synthetic pairing test',
  });
  const snap = (await ref.refresh()).agent;
  console.log(
    JSON.stringify({
      provider: snap.provider,
      mode: snap.currentModeId,
      cwdMatches: snap.cwd === workspace,
      status: snap.status,
    }),
  );
  server.listen(relayPort, '127.0.0.1');
  await once(server, 'listening');
  db = new Authority(join(d, 'authority.db'));
  const key = identity(randomBytes),
    invite = db.offer(key.publicKey, ref.id, workspace, 'auto'),
    g = parseOffer(invite.offer, key.publicKey, Date.now());
  const endpoint = 'http://127.0.0.1:' + relayPort + '/machine-agent-v1';
  const peer = async (side) => {
    const socket = io(endpoint, {
      autoConnect: false,
      forceNew: true,
      auth: { route: g.route, side, ...(side === 'device' ? { token: userToken } : {}) },
      transports: ['websocket'],
    });
    peers.push(socket);
    const ok = once(socket, 'connect');
    socket.connect();
    await ok;
    return socket;
  };
  const machine = await peer('machine'),
    device = await peer('device');
  machine.on('frame', async (wire) => {
    const item = db.admit(g.route, wire);
    if (item?.reply) machine.emit('frame', item.reply);
    if (!item?.job) return;
    const frame = await runReviewed(db, client, item.job, async () => true, new AbortController().signal);
    if (frame) machine.emit('frame', frame);
  });
  const request = async (action, n, body) => {
    const msg = [action, n, hex(randomBytes(16)), Date.now() + 60_000, body];
    const response = once(device, 'frame', { signal: AbortSignal.timeout(30_000) });
    device.emit('frame', seal(g, 'request', key.secretKey, msg, randomBytes));
    const [frame] = await response;
    return open(g, 'reply', key.secretKey, frame);
  };
  assert.equal((await request('pair', 0, g.token))[2], 'paired');
  const response = await request('turn', 1, 'Say Hello world');
  console.log(JSON.stringify({ status: response[2], result: response[3], providerStarts: calls }));
  assert.equal(response[2], 'result');
  assert.equal(calls, 1);
  console.log(
    'PASS real Paseo daemon with isolated deterministic provider, TCP relay and two sealed endpoints',
  );
} finally {
  peers.forEach((p) => p.close());
  await relay.close();
  await client?.close();
  await daemon.stop();
  db?.close();
  rmSync(d, { recursive: true, force: true });
}
