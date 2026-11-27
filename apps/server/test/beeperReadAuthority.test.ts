import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { BeeperReadAuthority } from '../../../scripts/beeper-client/readAuthority.mjs';
import { createBeeperReadonlyClient } from '../../../scripts/beeper-client/desktopApi.mjs';
import {
  openReadEnvelope,
  sealReadEnvelope,
  destination,
} from '../../mobile/src/services/beeper/readProtocol.mjs';
import {
  acceptBeeperReadOffer,
  enableBeeperReadRegistry,
} from '../../mobile/src/services/beeper/deviceRegistry';
import { authorizeBeeperRead } from '../../mobile/src/services/beeper/readIntent';

const local = vi.hoisted(() => ({ account: 'owner', storage: new Map<string, string>() }));
vi.mock('../../mobile/src/api/client', () => ({ getUser: async () => ({ userId: local.account }) }));
vi.mock('expo-crypto', () => ({
  getRandomValues: (b: Uint8Array) => crypto.getRandomValues(b),
  getRandomBytesAsync: async (n: number) => new Uint8Array(randomBytes(n)),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_: unknown, s: string) => createHash('sha256').update(s).digest('hex'),
}));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  isAvailableAsync: async () => true,
  getItemAsync: async (k: string) => local.storage.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    if (v.length > 2048) throw Error('oversize secure item');
    local.storage.set(k, v);
  },
}));
const key = () => {
  const p = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(p.publicKey).toString('hex'),
    secretKey: Buffer.from(p.secretKey).toString('hex'),
  };
};
const id = () => randomBytes(24).toString('hex');
let dir: string,
  paired: string,
  state: string,
  stop: (() => void) | undefined,
  authority: BeeperReadAuthority,
  registry: DatabaseSync;
const machine = key(),
  device = key(),
  pairRoute = id();
const chat = {
  id: 'local-chat',
  accountID: 'local-account',
  network: 'whatsapp',
  type: 'group',
  title: 'Selected',
};
let now: number;
beforeEach(() => {
  now = Date.now();
  dir = mkdtempSync(join(tmpdir(), 'beeper-read-test-'));
  paired = join(dir, 'paired');
  state = join(dir, 'state');
  mkdirSync(paired, { mode: 0o700 });
  const file = join(paired, 'authority.db');
  registry = new DatabaseSync(file);
  chmodSync(file, 0o600);
  registry.exec(
    'CREATE TABLE machine(id,pub,secret); CREATE TABLE grants(route,device,expires,state,context,relayTicket)',
  );
  registry.prepare('INSERT INTO machine VALUES(1,?,?)').run(machine.publicKey, machine.secretKey);
  registry
    .prepare("INSERT INTO grants VALUES(?,?,?,'active','opaque-context','fixture')")
    .run(pairRoute, device.publicKey, now + 86400000);
  local.account = 'owner';
  local.storage.clear();
  local.storage.set(
    'machine.agent.v1.owner',
    JSON.stringify({
      key: device,
      grant: {
        route: pairRoute,
        device: device.publicKey,
        machine: machine.publicKey,
        deviceTicket: randomBytes(32).toString('hex'),
      },
      expires: now + 86400000,
    }),
  );
  authority = new BeeperReadAuthority({ directory: state, pairingDirectory: paired, clock: () => now });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  authority.close();
  registry.close();
  rmSync(dir, { force: true, recursive: true });
});
async function fixture() {
  const options = {
    pairRoute,
    ownerId: 'owner',
    accountId: chat.accountID,
    destination,
    expiresAt: now + 3600000,
  };
  const { publicOffer, relayToken } = await authority.approveCatalogue(options, async () => true);
  const { grantId, wire } = await authority.approveChat(publicOffer.connectionId, chat, async () => true);
  const pins = { deviceKey: device.publicKey, machineKey: machine.publicKey };
  const selection = (openReadEnvelope(pins, 'grant', wire, device.secretKey) as any).scope;
  await acceptBeeperReadOffer('owner', wire, async (scope) => scope.chatKey === selection.chatKey);
  stop = enableBeeperReadRegistry('owner');
  const conn = { ...publicOffer, id: publicOffer.connectionId, state: 'active' };
  const entry = { chatKey: selection.chatKey, title: 'Selected', chatType: 'group' };
  const issue = async (kind = 'open', epoch = 1) => {
    const job = {
      id: id(),
      kind,
      epoch,
      accountKey: selection.accountKey,
      chatKey: selection.chatKey,
      connectionId: selection.route,
    };
    const intent = await authorizeBeeperRead(conn as any, job as any, entry as any,'owner');
    return { ...job, intent };
  };
  return { options, issue, entry, conn, publicOffer, relayToken, wire, selection, grantId, pins };
}
function adapter(n = 1, readToken = async () => 'synthetic') {
  const send = vi.fn(async (url: URL) => {
    expect(url.origin).toBe('http://127.0.0.1:23373');
    const items = Array.from({ length: n }, (_, i) => ({
      id: String(i),
      timestamp: '2026-10-01T00:00:00Z',
      senderID: 'sender',
      accountID: chat.accountID,
      chatID: chat.id,
      text: 'private',
    }));
    return Response.json({ items, hasMore: true, newestCursor: 'local-new', oldestCursor: 'local-old' });
  });
  return { api: createBeeperReadonlyClient({ readToken, fetchImpl: send }), send };
}
it('reuses both pinned keys and executes exactly one locally scoped GET across lost ACK and restart', async () => {
  const f = await fixture(),
    claim = await f.issue();
  expect(JSON.stringify(f.publicOffer)).not.toContain(f.relayToken);
  const ticket = authority.prepare(claim),
    a = adapter(154);
  await authority.read(ticket, a.api);
  expect(a.send).toHaveBeenCalledTimes(1);
  let b = authority.nextPending(ticket);
  expect(b.payload.messages.length).toBe(100);
  expect(() => authority.acknowledge(ticket, { ...b, chatId: 'chat' })).toThrow();
  const delivered = await authority.beforeDisclosure(ticket, b.sequence, async (saved) => saved);
  expect(delivered.digest).toBe(b.digest);
  authority.close();
  authority = new BeeperReadAuthority({ directory: state, pairingDirectory: paired, clock: () => now });
  const again = authority.prepare({ ...claim, nextSequence: 2 });
  await authority.read(again, a.api);
  expect(authority.nextPending(again)).toEqual(b);
  expect(a.send).toHaveBeenCalledTimes(1);
  expect(() =>
    authority.acknowledge(again, { sequence: 0, digest: '0'.repeat(64), chatId: 'chat' }),
  ).toThrow();
  authority.acknowledge(again, { sequence: 0, digest: b.digest, chatId: 'chat' });
  b = authority.beforeDisclosure(again, 1, (saved) => saved);
  expect(b.final).toBe(true);
  expect(b.payload.messages.length).toBe(54);
  authority.acknowledge(again, { sequence: 1, digest: b.digest, chatId: 'chat' });
  expect(authority.nextPending(again)).toBe(null);
  const earlier = await f.issue('earlier', 2);
  expect(() =>
    authority.prepare({
      ...earlier,
      cursor: 'untrusted',
      accountId: 'different',
      url: 'https://invalid.example',
    }),
  ).toThrow();
  await authority.read(authority.prepare(earlier), a.api);
  const url = a.send.mock.calls.at(-1)![0];
  expect(url.pathname).toBe('/v1/chats/local-chat/messages');
  expect(url.searchParams.get('cursor')).toBe('local-old');
});
it('rejects missing local consent, expired and cross-account device registry entries', async () => {
  const f = await fixture();
  expect(
    await authority
      .approveCatalogue({ ...f.options, expiresAt: now - 1 }, async () => true)
      .catch(() => false),
  ).toBe(false);
  await expect(
    authority.approveChat(f.selection.route, { ...chat, id: 'other' }, async () => false),
  ).rejects.toThrow();
  await expect(acceptBeeperReadOffer('owner', f.wire, async () => false)).rejects.toThrow();
  local.account = 'other';
  await expect(f.issue()).rejects.toThrow();
  local.account = 'owner';
  local.storage.delete('machine.agent.v1.owner');
  await expect(f.issue()).rejects.toThrow();
});
it('rejects role reflection, altered authenticated selection, epoch and duplicate request substitution', async () => {
  const f = await fixture(),
    claim = await f.issue();
  const value: any = openReadEnvelope(f.pins, 'read', claim.intent, machine.secretKey);
  expect(() => authority.prepare({ ...claim, intent: f.wire })).toThrow();
  for (const change of [
    { kind: 'earlier' },
    { epoch: 4 },
    { id: id() },
    { connectionId: id() },
    { chatKey: 'a'.repeat(64) },
    { accountKey: 'b'.repeat(64) },
  ])
    expect(() => authority.prepare({ ...claim, ...change })).toThrow();
  const forged = (change: any) =>
    sealReadEnvelope(f.pins, 'read', { ...value, ...change }, device.secretKey, randomBytes);
  for (const change of [
    { operation: 'send' },
    { pairRoute: id() },
    { ownerId: 'other' },
    { destination: 'https://other.invalid' },
    { grantId: id() },
    { cursor: 'bad' },
    { until: now - 1 },
  ]) {
    expect(() => authority.prepare({ ...claim, intent: forged(change) })).toThrow();
  }
  authority.prepare(claim);
  expect(() =>
    authority.prepare({
      ...claim,
      intent: forged({ sequence: value.sequence + 1, requestId: randomBytes(16).toString('hex') }),
    }),
  ).toThrow();
});
it.each(['beeper', 'pair', 'expire'])(
  'serializes %s revocation or expiry after token lookup and before fetch',
  async (mode) => {
    const f = await fixture(),
      claim = await f.issue(),
      ticket = authority.prepare(claim);
    const a = adapter(1, async () => {
      if (mode === 'beeper') authority.revoke(f.grantId);
      if (mode === 'pair') registry.exec("UPDATE grants SET state='revoked'");
      if (mode === 'expire') now += 600000;
      return 'synthetic';
    });
    await expect(authority.read(ticket, a.api)).rejects.toThrow();
    expect(a.send).not.toHaveBeenCalled();
    expect(() => authority.nextPending(ticket)).toThrow();
  },
);
it('suppresses staged disclosure on revoke and treats in-flight source failure conservatively', async () => {
  const f = await fixture(),
    claim = await f.issue(),
    ticket = authority.prepare(claim);
  const a = adapter();
  await authority.read(ticket, a.api);
  authority.revoke(f.selection.route);
  const publish = vi.fn();
  expect(() => authority.beforeDisclosure(ticket, 0, publish)).toThrow();
  expect(publish).not.toHaveBeenCalled();
});

it('refuses a relabelled catalogue and changed selected chat before client authorization', async () => {
  const f = await fixture(),
    job = { id: id(), kind: 'open', epoch: 1, state: 'pending', nextSequence: 0 };
  await expect(
    authorizeBeeperRead(f.conn as any, job as any, { ...f.entry, title: 'Other' } as any,'owner'),
  ).rejects.toThrow();
  await expect(
    authorizeBeeperRead(f.conn as any, job as any, { ...f.entry, chatType: 'direct' } as any,'owner'),
  ).rejects.toThrow();
});
it('separates local catalogue disclosure from history and fences publication after asynchronous credential lookup', async () => {
  const f = await fixture(),
    get = vi.fn(async () => Response.json({ items: [chat], hasMore: false }));
  const api = createBeeperReadonlyClient({ readToken: async () => 'synthetic', fetchImpl: get });
  const send = vi.fn();
  await expect(
    authority.readCatalogue(f.selection.route, api, async (body, beforeFetch) => {
      expect(body.items[0].title).toBe('Selected');
      expect(body.complete).toBe(false);
      expect(JSON.stringify(body)).not.toContain('local-chat');
      authority.revoke(f.publicOffer.catalogueGrantId);
      await beforeFetch(() => send(body));
    }),
  ).rejects.toThrow();
  expect(get).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});
it('lost GET outcome cannot cause another source read, and expired signed work cannot publish', async () => {
  const f = await fixture(),
    claim = await f.issue(),
    t = authority.prepare(claim),
    send = vi.fn(async () => {
      throw Error('synthetic network loss');
    });
  const api = createBeeperReadonlyClient({ readToken: async () => 'synthetic', fetchImpl: send });
  await expect(authority.read(t, api)).rejects.toThrow();
  authority.close();
  authority = new BeeperReadAuthority({ directory: state, pairingDirectory: paired, clock: () => now });
  await expect(authority.read(authority.prepare(claim), api)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
  now += 300001;
  expect(() => authority.prepare(claim)).toThrow();
});

it('binds the importer to the immutable approved principal and destination with a local secret', async () => {
  const f = await fixture(),
    offer = f.publicOffer;
  const proof = (owner: string, route: string) =>
    createHmac('sha256', f.relayToken)
      .update(
        JSON.stringify([
          offer.protocol,
          route,
          owner,
          offer.machineKey,
          offer.deviceKey,
          offer.accountKey,
          offer.catalogueGrantId,
          offer.expiresAt,
          offer.destination,
        ]),
      )
      .digest('hex');
  expect(proof('owner', offer.connectionId)).toBe(offer.relayBinding);
  expect(proof('other', offer.connectionId)).not.toBe(offer.relayBinding);
  expect(proof('owner', id())).not.toBe(offer.relayBinding);
});
it('recovers the exact sealed device intent after resolver restart without consuming a second sequence', async () => {
  const f = await fixture(),
    job = { id: id(), kind: 'open', epoch: 1, state: 'pending', nextSequence: 0 };
  const frame = await authorizeBeeperRead(f.conn as any, job as any, f.entry as any,'owner');
  stop?.();
  stop = enableBeeperReadRegistry('owner');
  expect(await authorizeBeeperRead(f.conn as any, job as any, f.entry as any,'owner')).toBe(frame);
  expect((openReadEnvelope(f.pins, 'read', frame, machine.secretKey) as any).sequence).toBe(1);
  const later = await authorizeBeeperRead(
    f.conn as any,
    { ...job, id: id(), epoch: 2 } as any,
    f.entry as any,
    'owner',
  );
  expect((openReadEnvelope(f.pins, 'read', later, machine.secretKey) as any).sequence).toBe(2);
});

it('cannot use the previous signed-in account registry for an authorization in another account',async()=>{
 const f=await fixture(),job={id:id(),kind:'open',epoch:1,state:'pending',nextSequence:0};
 await expect(authorizeBeeperRead(f.conn as any,job as any,f.entry as any,'different-owner')).rejects.toThrow();
});

it('abandons only the exact staged read, refuses replay and admits a fresh explicit device sequence', async()=>{
 const f=await fixture(),claim=await f.issue(),ticket=authority.prepare(claim),a=adapter();
 await authority.read(ticket,a.api);expect(authority.nextPending(ticket)).not.toBeNull();
 authority.abandon(ticket);expect(()=>authority.nextPending(ticket)).toThrow();expect(()=>authority.prepare(claim)).toThrow();
 const next=authority.prepare(await f.issue('refresh',2));await authority.read(next,a.api);expect(a.send).toHaveBeenCalledTimes(2);
});
