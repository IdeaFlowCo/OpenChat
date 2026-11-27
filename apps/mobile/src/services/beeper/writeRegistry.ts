// Native-only. The existing paired device key opens the local grant and seals
// intent. AsyncStorage holds ciphertext. SecureStore anchors its hash and the
// operation's permanent ownership. No module-level sender is installed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { getUser } from '../../api/client';
import { isHex } from './readProtocol.mjs';
import {
  deny,
  ownerId,
  exact,
  validOffer,
  validDisplay,
  validText,
  pinBody,
  writeBox,
  openWriteBox,
  openLocalWriteIntent,
  type Offer,
  type Display,
} from './writeProtocol.mjs';

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const prefix = 'beeper.write.v1.';
const hash = (s: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);
const random = (n: number) => Crypto.getRandomValues(new Uint8Array(n));
const save = (k: string, v: unknown) => SecureStore.setItemAsync(k, JSON.stringify(v), options);
async function load<T>(k: string): Promise<T | null> {
  const v = await SecureStore.getItemAsync(k, options);
  return v === null ? null : JSON.parse(v);
}
let writing = false;
async function exclusive<T>(work: () => Promise<T>) {
  if (writing) return deny();
  writing = true;
  try {
    return await work();
  } finally {
    writing = false;
  }
}
async function signedIn(account: string) {
  if (!ownerId(account) || (await getUser())?.userId !== account || !(await SecureStore.isAvailableAsync()))
    deny();
}
async function pair(account: string) {
  await signedIn(account);
  const d = await load<{
    key: { publicKey: string; secretKey: string };
    grant: {
      route: string;
      deviceTicket: string;
      machineHash: string;
      device: string;
      machine: string;
      expires: number;
    };
    expires: number;
    token?: string;
  }>('machine.agent.v1.' + account);
  const g = d?.grant;
  if (
    !d ||
    !g ||
    d.token ||
    !isHex(d.key?.publicKey, 64) ||
    !isHex(d.key.secretKey, 64) ||
    d.key.publicKey !== g.device ||
    !isHex(g.machine, 64) ||
    !isHex(g.deviceTicket, 64) ||
    !isHex(g.machineHash, 64) ||
    !isHex(g.route, 48) ||
    !Number.isSafeInteger(g.expires) ||
    d.expires !== g.expires ||
    d.expires <= Date.now()
  )
    return deny();
  const deviceTicketHash = await hash(g.deviceTicket);
  const route = (
    await hash(JSON.stringify(['openchat.relay.v2', account, g.expires, g.machineHash, deviceTicketHash]))
  ).slice(0, 48);
  if (route !== g.route) return deny();
  return {
    machineKey: g.machine,
    deviceKey: g.device,
    secret: d.key.secretKey,
    route,
    expires: g.expires,
    deviceTicketHash,
  };
}
type GrantState = { hash: string; seq: number; pending: string | null; disabled?: boolean };
type ReceiptState =
  | 'review'
  | 'approved'
  | 'attempted'
  | 'unknown'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'cancelled';
type State = 'prepared' | 'submitted' | ReceiptState;
type Op = {
  owner: string;
  route: string;
  chat: string;
  seq: number;
  until: number;
  frameHash: string;
  inputHash: string;
  state: State;
  revision: number;
};
const done = (s: State) => ['confirmed', 'cancelled', 'failed'].includes(s);
const receiptRank: Record<ReceiptState, number> = {
  review: 1,
  approved: 2,
  attempted: 3,
  unknown: 4,
  pending: 4,
  confirmed: 5,
  failed: 5,
  cancelled: 5,
};
function grantKey(account: string, route: string) {
  if (!ownerId(account) || !isHex(route, 48)) return deny();
  return prefix + 'grant.' + account + '.' + route;
}
function opKey(id: string) {
  if (!isHex(id, 48)) return deny();
  return prefix + 'op.' + id;
}
function openGrant(wire: string, p: Awaited<ReturnType<typeof pair>>, account: string) {
  const g = openWriteBox(p, 'grant', wire, p.secret) as { offer: Offer; pairRoute: string; display: Display };
  if (
    !exact(g, ['offer', 'pairRoute', 'display']) ||
    !validOffer(g.offer) ||
    !validDisplay(g.display) ||
    g.pairRoute !== p.route ||
    g.offer.ownerUserId !== account ||
    g.offer.deviceKey !== p.deviceKey ||
    g.offer.machineKey !== p.machineKey ||
    Date.parse(g.offer.expiresAt) > p.expires ||
    Date.parse(g.offer.expiresAt) <= Date.now()
  )
    return deny();
  return g;
}
async function current(account: string, route: string) {
  const p = await pair(account),
    k = grantKey(account, route),
    state = await load<GrantState>(k);
  const wire = await AsyncStorage.getItem(k + '.box');
  if (
    !state ||
    state.disabled ||
    !wire ||
    state.hash !== (await hash(wire)) ||
    !Number.isSafeInteger(state.seq) ||
    state.seq < 0
  )
    return deny();
  const g = openGrant(wire, p, account);
  if (g.offer.connectionId !== route) return deny();
  await signedIn(account);
  return { k, state, g, p };
}
type View = Offer & Display & { pendingOperationId: string | null };
export async function importWriteOffer(
  account: string,
  wire: string,
  confirm: (o: Readonly<Offer & Display>) => Promise<boolean>,
): Promise<Offer> {
  return exclusive(async () => {
    if (typeof confirm !== 'function') return deny();
    const p = await pair(account),
      g = openGrant(wire, p, account);
    if ((await confirm(Object.freeze({ ...g.offer, ...g.display }))) !== true) return deny();
    openGrant(wire, await pair(account), account);
    const k = grantKey(account, g.offer.connectionId),
      digest = await hash(wire),
      old = await load<GrantState>(k);
    if (old && (old.disabled || old.hash !== digest)) return deny();
    await AsyncStorage.setItem(k + '.box', wire);
    if (!old) await save(k, { hash: digest, seq: 0, pending: null });
    await current(account, g.offer.connectionId);
    return g.offer;
  });
}
export async function disableWriteGrant(account: string, route: string) {
  return exclusive(async () => {
    await signedIn(account);
    const k = grantKey(account, route),
      state = await load<GrantState>(k);
    if (!state) return deny();
    await save(k, { ...state, disabled: true });
  });
}
export async function readWriteGrant(account: string, route: string): Promise<View> {
  const { g, state } = await current(account, route);
  return { ...g.offer, ...g.display, pendingOperationId: state.pending };
}
export async function listWriteGrants(account: string): Promise<View[]> {
  await signedIn(account);
  const start = prefix + 'grant.' + account + '.',
    out: View[] = [];
  for (const k of await AsyncStorage.getAllKeys()) {
    if (!k.startsWith(start) || !k.endsWith('.box')) continue;
    const route = k.slice(start.length, -4);
    try {
      out.push(await readWriteGrant(account, route));
    } catch {
      /* Revoked, missing or stale local entry. */
    }
  }
  await signedIn(account);
  return out;
}
export type SendInput = { operationId: string; text: string; replyTo?: string | null };
export type SendFrame = { connectionId: string; operationId: string; opaqueIntent: string };
async function cached(id: string, op: Op): Promise<SendFrame> {
  const wire = await AsyncStorage.getItem(opKey(id) + '.box');
  if (!wire || (await hash(wire)) !== op.frameHash) return deny();
  return { connectionId: op.route, operationId: id, opaqueIntent: wire };
}
export async function prepareSend(
  account: string,
  route: string,
  chat: string,
  input: SendInput,
): Promise<SendFrame> {
  if (
    !exact(input, input?.replyTo === undefined ? ['operationId', 'text'] : ['operationId', 'text', 'replyTo'])
  )
    return deny();
  const { operationId: op, text } = input,
    reply = input.replyTo ?? null;
  return exclusive(async () => {
    const { g, p, state, k } = await current(account, route);
    if (g.offer.chatKey !== chat || !validText(text) || (reply !== null && !isHex(reply, 64))) return deny();
    const key = opKey(op),
      inputHash = await hash(JSON.stringify([account, route, chat, text, reply]));
    const prev = await load<Op>(key);
    if (prev) {
      if (
        prev.owner !== account ||
        prev.inputHash !== inputHash ||
        prev.state !== 'prepared' ||
        prev.route !== route ||
        prev.chat !== chat ||
        prev.until <= Date.now() ||
        state.pending !== op
      )
        return deny();
      const frame = await cached(op, prev);
      await current(account, route);
      return frame;
    }
    if (state.pending) {
      const prior = await load<Op>(opKey(state.pending));
      if (!prior || prior.route !== route || prior.owner !== account || !done(prior.state)) return deny();
    }
    const sequence = state.seq + 1,
      until = Math.min(Date.parse(g.offer.expiresAt), Date.now() + 240000);
    if (!Number.isSafeInteger(sequence) || until <= Date.now()) return deny();
    const frame = writeBox(
      p,
      'intent',
      {
        pins: pinBody(g.offer, p.route),
        operationId: op,
        sequence,
        until,
        text: text,
        replyTo: reply,
        deviceTicketHash: p.deviceTicketHash,
      },
      p.secret,
      random,
    );
    const meta: Op = {
      owner: account,
      route,
      chat,
      seq: sequence,
      until,
      frameHash: await hash(frame),
      inputHash,
      state: 'prepared',
      revision: 0,
    };
    // An uncommitted ciphertext cannot be submitted by this API. Anchor the
    // sequence/slot and operation before returning. Loss of one store or a
    // process death between anchors blocks the orphaned slot for local review.
    await AsyncStorage.setItem(key + '.box', frame);
    await save(k, { ...state, seq: sequence, pending: op });
    await save(key, meta);
    await current(account, route);
    return { connectionId: route, operationId: op, opaqueIntent: frame };
  });
}
async function owned(account: string, op: string) {
  await signedIn(account);
  const value = await load<Op>(opKey(op));
  if (!value || value.owner !== account) return deny();
  return value;
}
function status(id: string, o: Op) {
  return { operationId: id, connectionId: o.route, chatKey: o.chat, sequence: o.seq, state: o.state };
}
export async function getSendStatus(account: string, id: string) {
  return status(id, await owned(account, id));
}
export async function getSendDisplay(account: string, id: string) {
  const op = await owned(account, id),
    { p, g } = await current(account, op.route),
    frame = await cached(id, op);
  const v = openLocalWriteIntent(p, frame.opaqueIntent, p.secret) as {
    pins: string[];
    operationId: string;
    sequence: number;
    until: number;
    text: string;
    replyTo: string | null;
    deviceTicketHash: string;
  };
  if (
    JSON.stringify(v.pins) !== JSON.stringify(pinBody(g.offer, p.route)) ||
    v.operationId !== id ||
    v.sequence !== op.seq ||
    v.until !== op.until ||
    v.deviceTicketHash !== p.deviceTicketHash ||
    !validText(v.text) ||
    (v.replyTo !== null && !isHex(v.replyTo, 64)) ||
    op.inputHash !== (await hash(JSON.stringify([account, op.route, op.chat, v.text, v.replyTo])))
  )
    return deny();
  await signedIn(account);
  return { ...status(id, op), text: v.text, replyTo: v.replyTo, title: g.display.title };
}
// A lost enqueue acknowledgment can repeat transport of exactly these bytes.
// The route and the destination Mac cannot change, including after expiration.
export async function resumeSubmittedSend(account: string, id: string) {
  return exclusive(async () => {
    const op = await owned(account, id),
      { state } = await current(account, op.route);
    if (op.state === 'prepared' || done(op.state) || state.pending !== id) return deny();
    const frame = await cached(id, op);
    await current(account, op.route);
    return frame;
  });
}
export async function markSubmitAttempt(account: string, id: string) {
  return exclusive(async () => {
    const o = await owned(account, id),
      { state } = await current(account, o.route);
    if (o.state !== 'prepared' || state.pending !== id || o.until <= Date.now()) return deny();
    const frame = await cached(id, o);
    await save(opKey(id), { ...o, state: 'submitted' });
    await current(account, o.route);
    return frame;
  });
}
export async function recordSendReceipt(account: string, id: string, wire: string) {
  return exclusive(async () => {
    const o = await owned(account, id),
      { g, p, k, state } = await current(account, o.route);
    const v = openWriteBox(p, 'receipt', wire, p.secret) as {
      pins: string[];
      operationId: string;
      sequence: number;
      frameHash: string;
      state: ReceiptState;
      revision: number;
    };
    if (
      !exact(v, ['pins', 'operationId', 'sequence', 'frameHash', 'state', 'revision']) ||
      JSON.stringify(v.pins) !== JSON.stringify(pinBody(g.offer, p.route)) ||
      v.operationId !== id ||
      v.sequence !== o.seq ||
      v.frameHash !== o.frameHash ||
      !Object.prototype.hasOwnProperty.call(receiptRank, v.state) ||
      !Number.isSafeInteger(v.revision) ||
      v.revision < 1 ||
      v.revision < o.revision ||
      o.state === 'prepared' ||
      (v.revision === o.revision && v.state !== o.state) ||
      (done(o.state) && o.state !== v.state) ||
      (o.state !== 'submitted' && receiptRank[v.state] < receiptRank[o.state])
    )
      return deny();
    const next = { ...o, state: v.state, revision: v.revision };
    await save(opKey(id), next);
    if (done(v.state) && state.pending === id) await save(k, { ...state, pending: null });
    await signedIn(account);
    return status(id, next);
  });
}
