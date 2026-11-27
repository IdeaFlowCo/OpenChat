// The original paired machine and device are the only endpoints. Every boxed
// payload authenticates the write-only protocol, role and canonical audience.
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import { isHex } from './readProtocol.mjs';

export const protocol = 'openchat.beeper.send.v1';
export const audience = 'beeper.send';
export const destination = 'https://chat.ideaflow.app';
export const deny = () => {
  throw Error('write_approval_required');
};
export const ownerId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v);
export const exact = (v, names) =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === names.length &&
  names.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const fields = [
  'protocol',
  'connectionId',
  'ownerUserId',
  'machineKey',
  'deviceKey',
  'accountKey',
  'chatKey',
  'writeGrantId',
  'expiresAt',
  'destination',
  'relayTokenHash',
  'relayBinding',
];
export function publicTuple(o) {
  return [
    protocol,
    o.connectionId,
    o.ownerUserId,
    o.machineKey,
    o.deviceKey,
    o.accountKey,
    o.chatKey,
    o.writeGrantId,
    o.expiresAt,
    destination,
  ];
}
export function validOffer(o) {
  return (
    exact(o, fields) &&
    o.protocol === protocol &&
    o.destination === destination &&
    ownerId(o.ownerUserId) &&
    ['machineKey', 'deviceKey', 'accountKey', 'chatKey', 'relayTokenHash', 'relayBinding'].every((k) =>
      isHex(o[k], 64),
    ) &&
    ['connectionId', 'writeGrantId'].every((k) => isHex(o[k], 48)) &&
    typeof o.expiresAt === 'string' &&
    Number.isFinite(Date.parse(o.expiresAt)) &&
    new Date(o.expiresAt).toISOString() === o.expiresAt
  );
}
export function validText(text) {
  return typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text, 'utf8') <= 16000;
}
export function validDisplay(d) {
  return (
    exact(d, ['title', 'chatType', 'network']) &&
    typeof d.title === 'string' &&
    !!d.title.trim() &&
    d.title.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(d.title) &&
    ['direct', 'group'].includes(d.chatType) &&
    d.network === 'whatsapp'
  );
}
export function pinBody(o, pairRoute) {
  return [
    protocol,
    audience,
    destination,
    o.ownerUserId,
    o.connectionId,
    pairRoute,
    o.machineKey,
    o.deviceKey,
    o.accountKey,
    o.chatKey,
    o.writeGrantId,
    o.expiresAt,
  ];
}
export function writeBox(pins, kind, body, secret, random) {
  const header = transcript(pins, kind);
  const clear = Buffer.from(JSON.stringify([...header, body]), 'utf8');
  if (clear.length > 110000) return deny();
  const nonce = random(24);
  return Buffer.concat([
    nonce,
    nacl.box.after(clear, nonce, shared(pins, secret, kind === 'intent')),
  ]).toString('base64');
}
export function openWriteBox(pins, kind, frame, secret) {
  return openBox(pins, kind, frame, secret, kind !== 'intent');
}
export function openLocalWriteIntent(pins, frame, deviceSecret) {
  return openBox(pins, 'intent', frame, deviceSecret, true);
}
function openBox(pins, kind, frame, secret, isDevice) {
  const header = transcript(pins, kind);
  if (
    typeof frame !== 'string' ||
    frame.length < 56 ||
    frame.length > 150000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(frame)
  )
    return deny();
  const b = Buffer.from(frame, 'base64');
  if (b.toString('base64') !== frame) return deny();
  const clear = nacl.box.open.after(b.subarray(24), b.subarray(0, 24), shared(pins, secret, isDevice));
  if (!clear) return deny();
  const msg = JSON.parse(Buffer.from(clear).toString('utf8'));
  if (!Array.isArray(msg) || msg.length !== header.length + 1 || header.some((v, i) => msg[i] !== v))
    return deny();
  return msg[header.length];
}
function transcript(p, kind) {
  if (!['grant', 'intent', 'receipt'].includes(kind) || !isHex(p.deviceKey, 64) || !isHex(p.machineKey, 64))
    return deny();
  return [protocol, audience, destination, kind, p.machineKey, p.deviceKey];
}
function shared(p, secret, isDevice) {
  if (!isHex(secret, 64)) return deny();
  const sk = Buffer.from(secret, 'hex'),
    pk = Buffer.from(isDevice ? p.machineKey : p.deviceKey, 'hex');
  if (
    Buffer.from(nacl.box.keyPair.fromSecretKey(sk).publicKey).toString('hex') !==
      (isDevice ? p.deviceKey : p.machineKey) ||
    nacl.scalarMult(sk, pk).every((n) => n === 0)
  )
    return deny();
  return nacl.box.before(pk, sk);
}
