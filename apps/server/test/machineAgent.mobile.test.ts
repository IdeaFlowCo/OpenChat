import { expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { attachMachineRelay } from '../src/websocket/machineRelay';
import { Authority } from '../../../scripts/machine-agent/authority.mjs';
import { describeMachine, machineRequest } from '../../mobile/src/services/machineAgent/client';

const env = vi.hoisted(() => ({
  url: '',
  token: '',
  account: 'fixture',
  storage: new Map<string, string>(),
}));
vi.mock('../../mobile/src/api/client', () => ({
  get OPENCHAT_URL() {
    return env.url;
  },
  getAuthenticatedToken: async () => env.token,
  getUser: async () => ({ userId: env.account }),
}));
vi.mock('expo-crypto', () => ({ getRandomValues: (buf: Uint8Array) => crypto.getRandomValues(buf) }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  isAvailableAsync: async () => true,
  getItemAsync: async (k: string) => env.storage.get(k) ?? null,
  setItemAsync: async (k: string, s: string) => env.storage.set(k, s),
}));
test('native client actions through real relay preserve account isolation and receipt freshness', async () => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  env.token = jwt.sign({ userId: 'fixture', email: 'fixture@example.invalid' }, process.env.JWT_SECRET);
  const http = createServer(),
    relay = new Server(http);
  attachMachineRelay(relay);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw Error('No test port');
  env.url = 'http://127.0.0.1:' + addr.port;
  const state = new Authority(':memory:');
  const client = await describeMachine('fixture');
  const invite = state.offer(client.publicKey, randomUUID(), '/fixture', 'auto', 'fixture');
  state.db.prepare("UPDATE grants SET context='fixture' WHERE route=?").run(invite.route);
  const host = io(env.url + '/machine-agent-v2', {
    auth: { route: invite.route, side: 'machine', ticket: state.grant(invite.route).relayTicket },
    transports: ['websocket'],
    autoConnect: false,
  });
  host.on('connect_error', () => setTimeout(() => host.connect(), 20).unref());
  host.connect();
  const seen: string[] = [];
  let priorReply = '',
    turns = 0;
  host.on('frame', (wire) => {
    seen.push(wire);
    const item = state.admit(invite.route, wire);
    if (priorReply) host.emit('frame', priorReply); // stale valid ciphertext must not satisfy a fresh check
    if (item.reply) host.emit('frame', item.reply);
    else {
      turns++;
      state.dispatch(item.job);
      state.db
        .prepare("UPDATE grants SET stage='terminal',daemonTurn='fixture' WHERE route=?")
        .run(invite.route);
      state.db.prepare("INSERT INTO scoped_receipts VALUES(?,'fixture')").run(invite.route);
      priorReply = state.finish(item.job, 'result', 'private result', 'fixture');
      host.emit('frame', priorReply);
    }
  });
  const signal = AbortSignal.timeout(10_000);
  try {
    expect(await machineRequest('fixture', 'pair', invite.offer, signal)).toMatchObject({ status: 'paired' });
    expect(await machineRequest('fixture', 'turn', 'private prompt', signal)).toEqual({
      status: 'result',
      text: 'private result',
    });
    expect(await machineRequest('fixture', 'check', '', signal)).toEqual({
      status: 'result',
      text: 'private result',
    });
    expect(turns).toBe(1);
    expect(seen.join('')).not.toMatch(/private|prompt|result/);
    expect([...env.storage.values()].join('')).not.toMatch(/private prompt|private result/);
    expect((await describeMachine('other-account')).publicKey).not.toBe(client.publicKey);
    env.account = 'other-account';
    await expect(machineRequest('fixture', 'check', '', signal)).rejects.toThrow(/Sign in/);
    expect(seen).toHaveLength(3);
  } finally {
    host.close();
    await relay.close();
    state.close();
  }
}, 15_000);
