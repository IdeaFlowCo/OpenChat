import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { attachMachineRelay } from '../../apps/server/src/websocket/machineRelay.ts';

test('only a direct signed-in device receives the opposite peer’s ciphertext', async (t) => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const http = createServer(),
    relay = new Server(http);
  attachMachineRelay(relay);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const route = randomBytes(24).toString('hex'),
    endpoint = 'http://127.0.0.1:' + http.address().port + '/machine-agent-v1';
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
  const machine = await peer({ side: 'machine', route });
  const device = await peer({ side: 'device', route, token: jwt.sign(direct, process.env.JWT_SECRET) });
  const ciphertext = randomBytes(96).toString('base64'),
    received = once(machine, 'frame', { signal: AbortSignal.timeout(5000) });
  device.emit('frame', ciphertext);
  assert.equal((await received)[0], ciphertext);
  const disconnected = once(device, 'disconnect', { signal: AbortSignal.timeout(5000) });
  device.emit('frame', { action: 'turn', text: 'unsealed' });
  await disconnected;
});
