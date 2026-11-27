import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { attachMachineRelay, relayClientAddress } from '../../apps/server/src/websocket/machineRelay.ts';

test('only a direct signed-in device receives the opposite peer’s ciphertext', async (t) => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const http = createServer(),
    relay = new Server(http);
  attachMachineRelay(relay, 600);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const credentials = (owner) => {
    const machine = randomBytes(32).toString('hex'),
      device = randomBytes(32).toString('hex'),
      expires = Date.now() + 60_000;
    const machineHash = hash(machine),
      route = hash(JSON.stringify(['openchat.relay.v2', owner, expires, machineHash, hash(device)])).slice(
        0,
        48,
      );
    return {
      machine: { side: 'machine', route, ticket: machine },
      device: {
        side: 'device',
        route,
        ticket: device,
        machineHash,
        expires,
        token: jwt.sign({ userId: owner, email: 'fixture@example.invalid' }, process.env.JWT_SECRET),
      },
    };
  };
  const pair = credentials('synthetic'),
    { route } = pair.machine,
    endpoint = 'http://127.0.0.1:' + http.address().port + '/machine-agent-v2';
  const direct = { userId: 'synthetic', email: 'fixture@example.invalid' };
  const peers = [];
  const peer = async (auth, event = 'connect') => {
    const socket = io(endpoint, {
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      transports: ['websocket'],
      auth,
    });
    peers.push(socket);
    const ready = once(socket, event, { signal: AbortSignal.timeout(5000) });
    socket.connect();
    await ready;
    return socket;
  };
  t.after(async () => {
    peers.forEach((socket) => socket.close());
    await relay.close();
  });
  await peer({ side: 'device', route, token: 'invalid' }, 'connect_error');
  await peer(
    { side: 'device', route, token: jwt.sign({ ...direct, embedded: 'unlinked' }, process.env.JWT_SECRET) },
    'connect_error',
  );
  await peer(pair.machine, 'connect_error'); // unregistered machines allocate no route
  await peer({ ...pair.device, token: credentials('another').device.token }, 'connect_error');
  await peer({ ...pair.device, ticket: pair.machine.ticket }, 'connect_error');
  await peer(
    { ...pair.device, token: jwt.sign({ ...direct, embedded: 'test' }, process.env.JWT_SECRET) },
    'connect_error',
  );
  const device = await peer(pair.device);
  await peer({ ...pair.machine, ticket: pair.device.ticket }, 'connect_error');
  const machine = await peer(pair.machine);
  await peer(pair.device, 'connect_error');
  await peer(pair.machine, 'connect_error');
  const ciphertext = randomBytes(96).toString('base64'),
    received = once(machine, 'frame', { signal: AbortSignal.timeout(5000) });
  device.emit('frame', ciphertext);
  assert.equal((await received)[0], ciphertext);
  const disconnected = once(device, 'disconnect', { signal: AbortSignal.timeout(5000) });
  device.emit('frame', { action: 'turn', text: 'unsealed' });
  await disconnected;
  const others = [];
  for (let i = 0; i < 7; i++) others.push(await peer(credentials('synthetic').device));
  await peer(credentials('synthetic').device, 'connect_error');
  await once(machine, 'disconnect', { signal: AbortSignal.timeout(3000) });
  for (const p of others) p.close();
  await new Promise((resolve) => setTimeout(resolve, 650));
  await peer(credentials('synthetic').device);
});

test('only a trusted proxy can supply the quota address', () => {
  const headers = { 'x-forwarded-for': '192.0.2.8, 198.51.100.10' };
  assert.equal(relayClientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers }), '198.51.100.10');
  assert.equal(relayClientAddress({ socket: { remoteAddress: '203.0.113.1' }, headers }), '203.0.113.1');
});
