import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import nacl from 'tweetnacl';
import { BeeperWriteAuthority } from '../../../scripts/beeper-client/writeAuthority.mjs';
import { createBeeperWriteClient } from '../../../scripts/beeper-client/writeDesktopApi.mjs';
import { BeeperPinnedSendOutbox } from '../../../scripts/beeper-client/sendOutbox.mjs';
import {
  destination,
  pinBody,
  publicTuple,
  writeBox,
  openWriteBox,
} from '../../mobile/src/services/beeper/writeProtocol.mjs';
import { sealReadEnvelope } from '../../mobile/src/services/beeper/readProtocol.mjs';
import {
  getSendStatus,
  listSendSummaries,
  getSendDisplay,
  resumeSubmittedSend,
  disableWriteGrant,
  cancelPreparedSend,
  importWriteOffer,
  listWriteGrants,
  markSubmitAttempt,
  prepareSend,
  readWriteGrant,
  recordSendReceipt,
} from '../../mobile/src/services/beeper/writeRegistry';

const local = vi.hoisted(() => ({
  account: 'owner',
  secure: new Map<string, string>(),
  disk: new Map<string, string>(),
  failKey: '',
}));
vi.mock('../../mobile/src/api/client', () => ({ getUser: async () => ({ userId: local.account }) }));
vi.mock('expo-crypto', () => ({
  getRandomValues: (v: Uint8Array) => crypto.getRandomValues(v),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_: unknown, s: string) => sha(s),
}));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  isAvailableAsync: async () => true,
  getItemAsync: async (k: string) => local.secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    if (Buffer.byteLength(v) > 2048 || k === local.failKey) throw Error('secure write unavailable');
    local.secure.set(k, v);
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => local.disk.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      local.disk.set(k, v);
    },
    getAllKeys: async () => [...local.disk.keys()],
  },
}));

const id = () => randomBytes(24).toString('hex'),
  ticket = () => randomBytes(32).toString('hex'),
  sha = (v: string) => createHash('sha256').update(v).digest('hex');
function identity() {
  const p = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(p.publicKey).toString('hex'),
    secretKey: Buffer.from(p.secretKey).toString('hex'),
  };
}
const device = identity(),
  machine = identity(),
  pins = { machineKey: machine.publicKey, deviceKey: device.publicKey };
const chat = {
  id: 'mac-source-conversation',
  accountID: 'mac-source-account',
  title: 'Selected local chat',
  network: 'whatsapp',
  type: 'single',
};
let dir: string,
  state: string,
  reg: DatabaseSync,
  mac: BeeperWriteAuthority,
  kernel: BeeperPinnedSendOutbox,
  pairRoute: string,
  now: number,
  deviceTicketHash: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-write-'));
  state = join(dir, 'state');
  const paired = join(dir, 'paired');
  mkdirSync(paired, { mode: 0o700 });
  const path = join(paired, 'authority.db');
  reg = new DatabaseSync(path);
  chmodSync(path, 0o600);
  reg.exec(
    'CREATE TABLE grants(route,device,state,context,expires,relayTicket); CREATE TABLE machine(id,pub,secret)',
  );
  reg.prepare('INSERT INTO machine VALUES(1,?,?)').run(machine.publicKey, machine.secretKey);
  now = Date.now();
  const expires = now + 86400000,
    deviceTicket = ticket(),
    machineRole = ticket(),
    machineHash = sha(machineRole);
  deviceTicketHash = sha(deviceTicket);
  pairRoute = sha(
    JSON.stringify(['openchat.relay.v2', 'owner', expires, machineHash, deviceTicketHash]),
  ).slice(0, 48);
  reg
    .prepare("INSERT INTO grants VALUES(?,?,'active','bound',?,?)")
    .run(pairRoute, device.publicKey, expires, machineRole);
  local.account = 'owner';
  local.secure.clear();
  local.disk.clear();
  local.failKey = '';
  local.secure.set(
    'machine.agent.v1.owner',
    JSON.stringify({
      key: device,
      expires,
      grant: {
        device: device.publicKey,
        machine: machine.publicKey,
        route: pairRoute,
        expires,
        deviceTicket,
        machineHash,
      },
    }),
  );
  mac = new BeeperWriteAuthority({ directory: state, pairingDirectory: paired, clock: () => now });
  kernel = new BeeperPinnedSendOutbox({
    directory: state,
    machineKey: machine.publicKey,
    verifier: mac,
    clock: () => now,
  });
});
afterEach(() => {
  mac.close();
  kernel.close();
  reg.close();
  rmSync(dir, { recursive: true, force: true });
});
const opts = () => ({
  pairRoute,
  ownerId: 'owner',
  accountId: chat.accountID,
  chatMetadata: chat,
  expiresAt: now + 3600000,
  destination,
});
async function grant() {
  const m = await mac.approveWrite(opts(), async () => true);
  const offer = await importWriteOffer(
    'owner',
    m.wire,
    async (s) => s.title === chat.title && s.chatType === 'direct' && s.network === 'whatsapp',
  );
  return { m, offer, route: offer.connectionId, chatKey: offer.chatKey };
}
async function prepare() {
  const g = await grant(),
    op = id(),
    text = 'Synthetic private reply';
  const frame = await prepareSend('owner', g.route, g.chatKey, { operationId: op, text });
  return { ...g, op, text, frame };
}
it('binds true owner, paired endpoints, approved write offer and authenticated display', async () => {
  await expect(mac.approveWrite(opts(), async () => false)).rejects.toThrow();
  const { m, offer } = await grant();
  expect(m.relayToken).toMatch(/^ocbs_[A-Za-z0-9_-]{43}$/);
  expect(offer.relayBinding).toBe(
    createHmac('sha256', m.relayToken)
      .update(JSON.stringify(publicTuple(offer)))
      .digest('hex'),
  );
  expect(offer.relayTokenHash).toBe(sha(m.relayToken));
  expect(JSON.stringify(offer)).not.toMatch(/mac-source|Selected local/);
  expect(await listWriteGrants('owner')).toEqual([
    { ...offer, title: chat.title, chatType: 'direct', network: 'whatsapp', pendingOperationId: null },
  ]);
  expect(JSON.stringify([...local.disk])).not.toContain(chat.title);
  const read = sealReadEnvelope(pins, 'grant', { offer }, machine.secretKey, randomBytes);
  await expect(importWriteOffer('owner', read, async () => true)).rejects.toThrow();
  const other = await mac.approveWrite({ ...opts(), ownerId: 'other' }, async () => true);
  await expect(importWriteOffer('owner', other.wire, async () => true)).rejects.toThrow();
  await expect(importWriteOffer('other', other.wire, async () => true)).rejects.toThrow();
  const edited = JSON.parse(local.secure.get('machine.agent.v1.owner')!);
  edited.grant.machineHash = ticket();
  local.secure.set('machine.agent.v1.owner', JSON.stringify(edited));
  await expect(readWriteGrant('owner', offer.connectionId)).rejects.toThrow();
});
it('reserves the exact encrypted payload and Mac globally before the first submission', async () => {
  const f = await prepare();
  expect(await prepareSend('owner', f.route, f.chatKey, { operationId: f.op, text: f.text })).toEqual(
    f.frame,
  );
  await expect(
    prepareSend('owner', f.route, f.chatKey, { operationId: f.op, text: 'changed' }),
  ).rejects.toThrow();
  expect(await markSubmitAttempt('owner', f.op)).toEqual(f.frame);
  await expect(markSubmitAttempt('owner', f.op)).rejects.toThrow();
  await expect(
    prepareSend('owner', f.route, f.chatKey, { operationId: f.op, text: f.text }),
  ).rejects.toThrow();
  const other = await grant();
  await expect(
    prepareSend('owner', other.route, other.chatKey, { operationId: f.op, text: f.text }),
  ).rejects.toThrow();
  await expect(
    prepareSend('owner', f.route, f.chatKey, { operationId: id(), text: 'bypass' }),
  ).rejects.toThrow();
  expect((await getSendStatus('owner', f.op)).state).toBe('submitted');
  local.account = 'other';
  await expect(getSendStatus('other', f.op)).rejects.toThrow();
  expect(JSON.stringify([...local.secure, ...local.disk])).not.toContain(f.text);
});
it('holds a source POST behind local consent, reconciles past intent expiry and authenticates the final receipt', async () => {
  const f = await prepare();
  await markSubmitAttempt('owner', f.op);
  const confirm = vi.fn(async () => true);
  await kernel.authorize(f.frame, confirm);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: chat.title,
      text: f.text,
      machineKey: machine.publicKey,
      deviceKey: device.publicKey,
    }),
  );
  expect(() => mac.sealStatus(f.route, f.op, 'confirmed')).toThrow();
  const old = mac.sealStatus(f.route, f.op, 'approved');
  await recordSendReceipt('owner', f.op, old);
  const send = vi.fn(async (account: string, c: string, v: any) =>
    v.beforeFetch(() => ({ chatID: c, pendingMessageID: 'synthetic-pending' })),
  );
  expect((await kernel.dispatch(f.op, { send })).state).toBe('pending');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    chat.accountID,
    chat.id,
    expect.objectContaining({ text: f.text, replyToMessageId: null }),
  );
  const scope = mac.verify(f.frame);
  now = scope.until + 1;
  expect(mac.verify(f.frame)).toEqual(scope);
  expect(() => mac.admit(scope, () => true)).toThrow();
  expect(mac.admitStatus(scope, () => true)).toBe(true);
  await recordSendReceipt('owner', f.op, mac.sealStatus(f.route, f.op, 'pending'));
  await expect(recordSendReceipt('owner', f.op, old)).rejects.toThrow();
  const retrieve = vi.fn(async () => ({
    accountID: chat.accountID,
    chatID: chat.id,
    id: 'canonical',
    isSender: true,
    sendStatus: { status: 'SUCCESS' },
  }));
  expect((await kernel.reconcile(f.op, { retrieve })).state).toBe('confirmed');
  await kernel.dispatch(f.op, { send });
  expect(send).toHaveBeenCalledTimes(1);
  const final = mac.sealStatus(f.route, f.op, 'confirmed');
  expect((await recordSendReceipt('owner', f.op, final)).state).toBe('confirmed');
  expect((await recordSendReceipt('owner', f.op, final)).state).toBe('confirmed');
  expect((await readWriteGrant('owner', f.route)).pendingOperationId).toBeNull();
  expect(final).not.toContain('canonical');
  expect(() => mac.admitStatus(scope, () => true)).toThrow();
});
it('rejects swapped frames, altered pins, source overrides, conflicting reuse and unbound reply IDs', async () => {
  const f = await prepare(),
    v = openWriteBox(pins, 'intent', f.frame.opaqueIntent, machine.secretKey) as Record<string, unknown>;
  const patch = (change: Record<string, unknown>) => ({
    ...f.frame,
    opaqueIntent: writeBox(pins, 'intent', { ...v, ...change }, device.secretKey, randomBytes),
  });
  for (const change of [
    { chatId: chat.id },
    { url: 'https://invalid.example' },
    { replyTo: chat.id },
    { replyTo: ticket() },
    { deviceTicketHash: ticket() },
    { pins: [] },
    { operationId: id() },
  ])
    expect(() => mac.verify(patch(change))).toThrow();
  expect(() => mac.verify({ ...f.frame, operationId: id() })).toThrow();
  const scope = mac.verify(f.frame);
  expect(() => mac.verify(patch({ text: 'substituted' }))).toThrow();
  expect(() => mac.admit({ ...scope, chatId: 'foreign' }, () => true)).toThrow();
  const late = patch({ operationId: id(), until: now - 1 });
  expect(() =>
    mac.verify({
      ...late,
      operationId: (openWriteBox(pins, 'intent', late.opaqueIntent, machine.secretKey) as any).operationId,
    }),
  ).toThrow();
});
it('derives quoted message targets solely from the matching local mapping and verifies both revocation ledgers', async () => {
  const f = await grant(),
    op = id();
  expect(() =>
    mac.bindReplyTarget(f.route, { accountID: chat.accountID, chatID: 'other', id: 'm' }),
  ).toThrow();
  const replyTo = mac.bindReplyTarget(f.route, {
    accountID: chat.accountID,
    chatID: chat.id,
    id: 'source-parent',
  });
  const frame = await prepareSend('owner', f.route, f.chatKey, { operationId: op, text: 'quote', replyTo });
  const scope = mac.verify(frame);
  expect(scope.replyToMessageId).toBe('source-parent');
  const start = vi.fn(() => true);
  reg.exec("UPDATE grants SET state='revoked'");
  expect(() => mac.admit(scope, start)).toThrow();
  expect(start).not.toHaveBeenCalled();
  reg.exec("UPDATE grants SET state='active'");
  mac.revoke(f.route);
  expect(() => mac.verify(frame)).toThrow();
  expect(() => mac.admit(scope, start)).toThrow();
});
it('independently recomputes the parent owner from the role-ticket commitments on the Mac', async () => {
  const m = await mac.approveWrite({ ...opts(), ownerId: 'wrong-owner' }, async () => true),
    o = m.publicOffer,
    op = id();
  const body = {
    pins: pinBody(o, pairRoute),
    operationId: op,
    sequence: 1,
    until: now + 20000,
    text: 'synthetic',
    replyTo: null,
    deviceTicketHash,
  };
  const opaqueIntent = writeBox(pins, 'intent', body, device.secretKey, randomBytes);
  expect(() => mac.verify({ connectionId: o.connectionId, operationId: op, opaqueIntent })).toThrow();
});
it('bounds secure items and fails closed if a crash separates ciphertext and the ownership anchors', async () => {
  const f = await grant(),
    op = id(),
    text = 'é'.repeat(8000);
  local.failKey = 'beeper.write.v1.op.' + op;
  await expect(prepareSend('owner', f.route, f.chatKey, { operationId: op, text })).rejects.toThrow();
  local.failKey = '';
  await expect(markSubmitAttempt('owner', op)).rejects.toThrow();
  await expect(prepareSend('owner', f.route, f.chatKey, { operationId: id(), text })).rejects.toThrow();
  const g = await grant(),
    newId = id();
  const wire = await prepareSend('owner', g.route, g.chatKey, { operationId: newId, text });
  expect(mac.verify(wire).text).toBe(text);
  expect([...local.secure.values()].every((v) => Buffer.byteLength(v) <= 2048)).toBe(true);
  local.disk.set('beeper.write.v1.op.' + newId + '.box', 'substituted');
  await expect(markSubmitAttempt('owner', newId)).rejects.toThrow();
});

it('revokes the real verifier during the second token lookup and performs no source POST', async () => {
  const f = await prepare();
  await markSubmitAttempt('owner', f.op);
  await kernel.authorize(f.frame, async () => true);
  let lookups = 0;
  const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
    expect(init.method).toBe('GET');
    return Response.json({ id: chat.id, accountID: chat.accountID, network: chat.network });
  });
  const adapter = createBeeperWriteClient({
    fetchImpl,
    readWriteToken: async () => {
      if (++lookups === 2) mac.revoke(f.route);
      return 'synthetic-local-token';
    },
  });
  expect((await kernel.dispatch(f.op, adapter)).state).toBe('unknown');
  expect(lookups).toBe(2);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await kernel.dispatch(f.op, adapter);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(() => mac.sealStatus(f.route, f.op, 'confirmed')).toThrow();
});
it('preserves original text across asynchronous storage and rejects a changed account at confirmation', async () => {
  const f = await grant(),
    op = id();
  const input = { operationId: op, text: 'original locally selected text' };
  const promise = prepareSend('owner', f.route, f.chatKey, input);
  input.text = 'different text';
  expect(mac.verify(await promise).text).toBe('original locally selected text');
  const next = await mac.approveWrite(opts(), async () => true);
  await expect(
    importWriteOffer('owner', next.wire, async () => {
      local.account = 'other';
      return true;
    }),
  ).rejects.toThrow();
});

it('replays the very same receipt bytes and revision after lost ACK and Mac authority restart', async () => {
  const f = await prepare();
  await markSubmitAttempt('owner', f.op);
  await kernel.authorize(f.frame, async () => false);
  const receipt = mac.statusReceipt(f.route, f.op, 'cancelled');
  expect(receipt).toMatchObject({ operationId: f.op, revision: 1, terminal: true });
  mac.close();
  mac = new BeeperWriteAuthority({
    directory: state,
    pairingDirectory: join(dir, 'paired'),
    clock: () => now,
  });
  expect(mac.statusReceipt(f.route, f.op, 'cancelled')).toEqual(receipt);
  expect((await recordSendReceipt('owner', f.op, receipt.wire)).state).toBe('cancelled');
});

it('locally displays and explicitly retries only byte-identical previously submitted ciphertext, and remembers local disable', async () => {
  const f = await prepare();
  expect(await getSendDisplay('owner', f.op)).toMatchObject({
    title: chat.title,
    text: f.text,
    replyTo: null,
    operationId: f.op,
    state: 'prepared',
  });
  await expect(resumeSubmittedSend('owner', f.op)).rejects.toThrow();
  await markSubmitAttempt('owner', f.op);
  expect(await resumeSubmittedSend('owner', f.op)).toEqual(f.frame);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + 301000);
  try {
    expect((await getSendDisplay('owner', f.op)).state).toBe('submitted');
    expect(await resumeSubmittedSend('owner', f.op)).toEqual(f.frame);
  } finally {
    clock.mockRestore();
  }
  await disableWriteGrant('owner', f.route);
  expect(await listWriteGrants('owner')).toEqual([]);
  await expect(importWriteOffer('owner', f.m.wire, async () => true)).rejects.toThrow();
  await expect(resumeSubmittedSend('owner', f.op)).rejects.toThrow();
  expect((await getSendStatus('owner', f.op)).state).toBe('submitted');
});

it('rechecks the exact cached receipt, current kernel state and both grants at final upload start', async () => {
  const f = await prepare();
  await kernel.authorize(f.frame, async () => true);
  const first = mac.statusReceipt(f.route, f.op, 'approved'),
    start = vi.fn(() => Promise.resolve('disclosed'));
  expect(() =>
    mac.beforeStatusDisclosure(f.route, f.op, { ...first, wire: first.wire + 'x' }, start),
  ).toThrow();
  kernel.cancel(f.op);
  expect(() => mac.beforeStatusDisclosure(f.route, f.op, first, start)).toThrow();
  const final = mac.statusReceipt(f.route, f.op, 'cancelled');
  await expect(mac.beforeStatusDisclosure(f.route, f.op, final, start)).resolves.toBe('disclosed');
  reg.exec("UPDATE grants SET state='revoked'");
  expect(() => mac.beforeStatusDisclosure(f.route, f.op, final, start)).toThrow();
  reg.exec("UPDATE grants SET state='active'");
  mac.revoke(f.route);
  expect(() => mac.beforeStatusDisclosure(f.route, f.op, final, start)).toThrow();
  expect(start).toHaveBeenCalledTimes(1);
});

it('discards an expired unsubmitted draft and permanently spends its operation ID and sequence', async () => {
  const f = await prepare();
  local.account = 'other';
  await expect(cancelPreparedSend('other', f.op)).rejects.toThrow();
  local.account = 'owner';
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + 301000);
  try {
    await expect(markSubmitAttempt('owner', f.op)).rejects.toThrow();
    expect((await cancelPreparedSend('owner', f.op)).state).toBe('cancelled');
    expect((await readWriteGrant('owner', f.route)).pendingOperationId).toBeNull();
    await expect(
      prepareSend('owner', f.route, f.chatKey, { operationId: f.op, text: f.text }),
    ).rejects.toThrow();
    await expect(resumeSubmittedSend('owner', f.op)).rejects.toThrow();
    const next = id();
    await prepareSend('owner', f.route, f.chatKey, { operationId: next, text: 'next draft' });
    expect((await getSendStatus('owner', next)).sequence).toBe(2);
    await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
    expect((await readWriteGrant('owner', f.route)).pendingOperationId).toBe(next);
  } finally {
    clock.mockRestore();
  }
});
it('refuses local cancellation after the submit fence and after an authenticated unknown result', async () => {
  const f = await prepare();
  await markSubmitAttempt('owner', f.op);
  await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
  await kernel.authorize(f.frame, async () => true);
  await kernel.dispatch(f.op, {
    send: async () => {
      throw Error('transport lost');
    },
  });
  const receipt = mac.sealStatus(f.route, f.op, 'unknown');
  await recordSendReceipt('owner', f.op, receipt);
  await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
  expect((await readWriteGrant('owner', f.route)).pendingOperationId).toBe(f.op);
  expect((await getSendStatus('owner', f.op)).state).toBe('unknown');
});
it('recovers a failed slot-clear without making the cancelled draft submit-capable', async () => {
  const f = await prepare();
  local.failKey = 'beeper.write.v1.grant.owner.' + f.route;
  await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
  local.failKey = '';
  expect((await getSendStatus('owner', f.op)).state).toBe('cancelled');
  await expect(markSubmitAttempt('owner', f.op)).rejects.toThrow();
  await cancelPreparedSend('owner', f.op);
  expect((await readWriteGrant('owner', f.route)).pendingOperationId).toBeNull();
});

it('serializes a discard racing first submission and preserves attempted and pending source states', async () => {
  const f = await prepare();
  const submit = markSubmitAttempt('owner', f.op);
  await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
  await submit;
  await kernel.authorize(f.frame, async () => true);
  await kernel.dispatch(f.op, {
    send: async () => {
      await recordSendReceipt('owner', f.op, mac.sealStatus(f.route, f.op, 'attempted'));
      await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
      return { chatID: chat.id, pendingMessageID: 'fixture-pending' };
    },
  });
  await recordSendReceipt('owner', f.op, mac.sealStatus(f.route, f.op, 'pending'));
  await expect(cancelPreparedSend('owner', f.op)).rejects.toThrow();
  expect((await getSendStatus('owner', f.op)).state).toBe('pending');
  const other = await prepare();
  const discard = cancelPreparedSend('owner', other.op);
  await expect(markSubmitAttempt('owner', other.op)).rejects.toThrow();
  expect((await discard).state).toBe('cancelled');
});

it('retains passive owner-local unresolved metadata after grant loss and refuses another account',async()=>{
 const f=await grant(),op=id();await prepareSend('owner',f.route,f.chatKey,{operationId:op,text:'private draft'});await markSubmitAttempt('owner',op);
 await disableWriteGrant('owner',f.route);const summaries=await listSendSummaries('owner');expect(summaries).toEqual([expect.objectContaining({operationId:op,state:'submitted'})]);expect(JSON.stringify(summaries)).not.toContain('private draft');expect(JSON.stringify(summaries)).not.toContain('secret');
 local.account='other';expect(await listSendSummaries('other')).toEqual([]);
});
