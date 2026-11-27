// Shared by the native signer and the machine verifier. All key material comes
// from the existing, independently enrolled device/machine identity.
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

export const protocol = 'openchat.beeper.read.v1';
export const audience = 'beeper.read';
export const imessageProtocol = 'openchat.beeper.imessage.read.v1';
export const imessageAudience = 'beeper.imessage.read';
export function readContract(network = 'whatsapp') {
  if (network === 'whatsapp') return { protocol, audience };
  if (network === 'imessage') return { protocol: imessageProtocol, audience: imessageAudience, network: 'imessage' };
  throw Error('Unsupported read network');
}
export function selectionNetwork(s) {
  if (s?.protocol === protocol && s.audience === audience && s.network === undefined) return 'whatsapp';
  if (s?.protocol === imessageProtocol && s.audience === imessageAudience && s.network === 'imessage') return 'imessage';
  return null;
}
export const destination = 'https://chat.ideaflow.app';
export const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[a-f0-9]+$/.test(s);
export function sameSelection(a, b) {
  return [
    'protocol',
    'audience',
    'network',
    'route',
    'machineKey',
    'deviceKey',
    'accountKey',
    'chatKey',
    'grantId',
    'ownerId',
    'pairRoute',
    'destination',
    'expiresAt',
  ].every((k) => a[k] === b[k]);
}
export function validSelection(s) {
  return (
    !!s &&
    selectionNetwork(s) !== null &&
    s.destination === destination &&
    typeof s.ownerId === 'string' &&
    /^[a-zA-Z0-9_-]{1,120}$/.test(s.ownerId) &&
    ['machineKey', 'deviceKey', 'accountKey', 'chatKey'].every((k) => isHex(s[k], 64)) &&
    ['route', 'grantId', 'pairRoute'].every((k) => isHex(s[k], 48)) &&
    Number.isSafeInteger(s.expiresAt)
  );
}
function keys(secret, pins, local) {
  const own = local === 'device' ? pins.deviceKey : pins.machineKey;
  const peer = local === 'device' ? pins.machineKey : pins.deviceKey;
  if (!isHex(secret, 64) || !isHex(own, 64) || !isHex(peer, 64)) throw Error('Invalid local pairing');
  const sk = Buffer.from(secret, 'hex'),
    pk = Buffer.from(peer, 'hex');
  if (
    Buffer.from(nacl.box.keyPair.fromSecretKey(sk).publicKey).toString('hex') !== own ||
    nacl.scalarMult(sk, pk).every((x) => x === 0)
  )
    throw Error('Invalid local pairing');
  return nacl.box.before(pk, sk);
}
function header(pins, purpose) {
  if (!['grant', 'read'].includes(purpose)) throw Error('Invalid envelope purpose');
  const contract = readContract(pins.network);
  return [contract.protocol, contract.audience, destination, purpose, pins.machineKey, pins.deviceKey];
}
export function sealReadEnvelope(pins, purpose, value, secret, random) {
  const nonce = random(24);
  const body = Buffer.from(JSON.stringify([...header(pins, purpose), value]), 'utf8');
  if (body.length > 12000) throw Error('Read envelope too large');
  const box = nacl.box.after(body, nonce, keys(secret, pins, purpose === 'grant' ? 'machine' : 'device'));
  return Buffer.concat([nonce, box]).toString('base64');
}
export function openReadEnvelope(pins, purpose, wire, secret) {
  if (
    typeof wire !== 'string' ||
    wire.length < 56 ||
    wire.length > 18000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(wire)
  )
    throw Error('Invalid sealed read');
  const b = Buffer.from(wire, 'base64');
  if (b.toString('base64') !== wire) throw Error('Invalid sealed read');
  const value = nacl.box.open.after(
    b.subarray(24),
    b.subarray(0, 24),
    keys(secret, pins, purpose === 'grant' ? 'device' : 'machine'),
  );
  if (!value) throw Error('Invalid sealed read');
  const v = JSON.parse(Buffer.from(value).toString('utf8')),
    h = header(pins, purpose);
  if (!Array.isArray(v) || v.length !== h.length + 1 || !h.every((x, i) => v[i] === x))
    throw Error('Different read audience');
  return v[h.length];
}
