import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';
import jwt from 'jsonwebtoken';
import { Authority } from './authority.mjs';
import { connectLocal, interruptDispatched } from './paseo.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  seal,
  open,
  identity,
  hex,
  parseOffer,
} from '../../apps/mobile/src/services/machineAgent/channel.mjs';
import { attachMachineRelay } from '../../apps/server/src/websocket/machineRelay.ts';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';

const install = process.env.PASEO_TEST_INSTALL,
  source = process.env.PASEO_TEST_SOURCE;
if (!install?.startsWith('/') || !source?.startsWith('/'))
  throw Error('Set absolute PASEO_TEST_INSTALL and PASEO_TEST_SOURCE paths.');
const dependencyRevision = 'db87bf6e2246748deef7136be032e98413b07025';
for (const dir of new Set([source, install])) {
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(head, dependencyRevision, 'Use the reviewed Paseo revision');
  execFileSync('git', ['-C', dir, 'diff', '--quiet', 'HEAD', '--', 'packages']);
}
const p = install;
const d = mkdtempSync(join(tmpdir(), 'openchat-paseo-test-')),
  workspace = join(d, 'workspace');
mkdirSync(workspace);
process.env.TMPDIR = d;
const fixture = readFileSync(
  join(source, 'packages/server/src/server/test-utils/fake-agent-client.ts'),
  'utf8',
);
await build({
  stdin: { contents: fixture, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: {
    '@getpaseo/protocol/tool-name-normalization': join(
      p,
      'packages/protocol/dist/tool-name-normalization.js',
    ),
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
// All CLI activity stays in this synthetic daemon home and private loopback relay.
delete process.env.PASEO_PASSWORD;
delete process.env.OPENCHAT_MACHINE_HOME;
process.env.OPENCHAT_PASEO_HOME = d;
process.env.OPENCHAT_MACHINE_RELAY = 'http://127.0.0.1:' + relayPort;
const terminals = [];
function cli(op, id, agent = '', cwd = '', account = '') {
  const child = spawn(
    'script',
    [
      '-qefc',
      'exec node scripts/machine-agent/host.mjs "$TEST_OP" "$TEST_ID" "$TEST_AGENT" "$TEST_CWD" "$TEST_ACCOUNT"',
      '/dev/null',
    ],
    {
      env: {
        ...process.env,
        TEST_OP: op,
        TEST_ID: id,
        TEST_AGENT: agent,
        TEST_CWD: cwd,
        TEST_ACCOUNT: account,
      },
      detached: true,
    },
  );
  terminals.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.resume();
  const exit = once(child, 'exit').then(([code]) => code);
  return {
    exit,
    async waitFor(needle) {
      for (let i = 0; i < 400; i++) {
        const at = output.indexOf(needle);
        if (at !== -1) {
          output = output.slice(at + needle.length);
          return;
        }
        if (child.exitCode !== null) break;
        await delay(25);
      }
      throw Error('Private terminal did not reach expected ' + op + ' prompt');
    },
    answer(text) {
      child.stdin.write(text + '\n');
    },
  };
}
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
  const stateDir = join(d, 'openchat-machine');
  mkdirSync(stateDir, { mode: 0o700 });
  const ledger = join(stateDir, 'authority.db');
  db = new Authority(ledger);
  chmodSync(ledger, 0o600);
  const key = identity(randomBytes);
  const decline = cli('offer', key.publicKey, ref.id, workspace, 'synthetic');
  await decline.waitFor('then type approve:');
  decline.answer('decline');
  assert.equal(await decline.exit, 0);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
  const enroll = cli('offer', key.publicKey, ref.id, workspace, 'synthetic');
  await enroll.waitFor('then type approve:');
  enroll.answer('approve');
  assert.equal(await enroll.exit, 0);
  const offerFile = readdirSync(stateDir).find((name) => name.endsWith('.offer'));
  const g = parseOffer(
    readFileSync(join(stateDir, offerFile), 'utf8'),
    key.publicKey,
    Date.now(),
    'synthetic',
  );
  const endpoint = 'http://127.0.0.1:' + relayPort + '/machine-agent-v2';
  const peer = async (side) => {
    const socket = io(endpoint, {
      autoConnect: false,
      forceNew: true,
      auth: {
        route: g.route,
        side,
        ...(side === 'device'
          ? { token: userToken, ticket: g.deviceTicket, machineHash: g.machineHash, expires: g.expires }
          : { ticket: db.grant(g.route).relayTicket }),
      },
      transports: ['websocket'],
    });
    peers.push(socket);
    const ok = once(socket, 'connect');
    socket.connect();
    await ok;
    return socket;
  };
  const device = await peer('device');
  const ready = once(device, 'ready', { signal: AbortSignal.timeout(10_000) });
  const listener = cli('serve', g.route);
  await ready;
  const request = async (action, n, body) => {
    const msg = [action, n, hex(randomBytes(16)), Date.now() + 60_000, body];
    const response = once(device, 'frame', { signal: AbortSignal.timeout(30_000) });
    device.emit('frame', seal(g, 'request', key.secretKey, msg, randomBytes));
    const [frame] = await response;
    return open(g, 'reply', key.secretKey, frame);
  };
  assert.equal((await request('pair', 0, g.token))[2], 'paired');
  const declined = request('turn', 1, 'private declined message');
  await listener.waitFor('Type approve to send this exact text:');
  listener.answer('decline');
  assert.equal((await declined)[2], 'denied');
  assert.equal(calls, 0);
  const accepted = request('turn', 2, 'Say Hello world');
  await listener.waitFor('Type approve to send this exact text:');
  listener.answer('approve');
  const response = await accepted;
  console.log(JSON.stringify({ status: response[2], result: response[3], providerStarts: calls }));
  assert.equal(response[2], 'result');
  assert.equal(calls, 1);
  assert.equal((await request('turn', 3, ' /compact'))[2], 'denied');
  assert.equal(calls, 1);
  const next = request('turn', 3, 'Say Hello world again');
  await listener.waitFor('Type approve to send this exact text:');
  listener.answer('approve');
  const again = await next;
  assert.equal(again[2], 'result');
  assert.equal(calls, 2);
  // Another process cannot turn a stale reviewed RPC into new provider work.
  const msg = ['turn', 4, hex(randomBytes(16)), Date.now() + 60_000, 'scope test'];
  const { job } = db.admit(g.route, seal(g, 'request', key.secretKey, msg, randomBytes));
  const permit = db.dispatch(job);
  assert.equal(
    (await client.localApprovedTurn({ ...permit, op: 'run', text: 'substituted' })).status,
    'denied',
  );
  db.db.prepare("UPDATE grants SET mode='read-only' WHERE route=?").run(g.route);
  assert.equal((await client.localApprovedTurn({ ...permit, op: 'run' })).status, 'denied');
  db.db.prepare("UPDATE grants SET mode='auto',deadline=? WHERE route=?").run(Date.now() - 1, g.route);
  assert.equal((await client.localApprovedTurn({ ...permit, op: 'run' })).status, 'denied');
  const revoked = cli('revoke', g.route);
  assert.equal(await revoked.exit, 1); // unresolved reserved request is reported locally
  assert.equal(db.grant(g.route).state, 'revoked');
  assert.equal(await interruptDispatched(db, client, g.route), false);
  assert.equal(calls, 2);
  assert.throws(
    () => db.offer(identity(randomBytes).publicKey, ref.id, workspace, 'auto', 'other'),
    /fresh agent/,
  );
  const heldAgent = await client.agents.create({
    config: { provider: 'codex/mock-model', modeId: 'auto' },
    cwd: workspace,
    title: 'Synthetic cancellation check',
  });
  const heldKey = identity(randomBytes);
  const heldOffer = cli('offer', heldKey.publicKey, heldAgent.id, workspace, 'synthetic');
  await heldOffer.waitFor('then type approve:');
  heldOffer.answer('approve');
  assert.equal(await heldOffer.exit, 0);
  const heldFile = readdirSync(stateDir).find((name) => name.endsWith('.offer'));
  const grant = parseOffer(
    readFileSync(join(stateDir, heldFile), 'utf8'),
    heldKey.publicKey,
    Date.now(),
    'synthetic',
  );
  const ask = (verb, seq, text) =>
    db.admit(
      grant.route,
      seal(
        grant,
        'request',
        heldKey.secretKey,
        [verb, seq, hex(randomBytes(16)), Date.now() + 60_000, text],
        randomBytes,
      ),
    );
  assert.equal(open(grant, 'reply', heldKey.secretKey, ask('pair', 0, grant.token).reply)[2], 'paired');
  const approved = ask('turn', 1, 'create a file named "fixture.txt" with the content "held for review"');
  const heldPermit = db.dispatch(approved.job);
  assert.equal(
    (await client.localApprovedTurn({ op: 'run', ...heldPermit, proof: hex(randomBytes(32)) })).status,
    'denied',
  );
  const active = client.localApprovedTurn({ op: 'run', ...heldPermit });
  let pending = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const { agent } = await heldAgent.refresh();
    if (
      agent.pendingPermissions?.length &&
      db.grant(grant.route).nativeThread &&
      db.grant(grant.route).nativeTurn
    ) {
      pending = true;
      break;
    }
    await delay(25);
  }
  assert.equal(pending, true, 'The synthetic provider is held at a local permission prompt');
  const stopActive = cli('revoke', grant.route);
  assert.equal(
    await stopActive.exit,
    0,
    'The real daemon confirms cancellation of the exact active fixture turn',
  );
  assert.equal((await active).status, 'quarantined');
  assert.equal(db.grant(grant.route).stage, 'interrupted');
  assert.equal(calls, 3);
  console.log(
    'PASS real scoped operation refuses a wrong local proof and terminal revoke confirms the exact held synthetic turn',
  );
  console.log(
    'PASS real Paseo daemon with isolated deterministic provider, TCP relay and two sealed endpoints',
  );
} finally {
  for (const child of terminals) {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  }
  peers.forEach((p) => p.close());
  await relay.close();
  await client?.close();
  await daemon.stop();
  db?.close();
  rmSync(d, { recursive: true, force: true });
}
