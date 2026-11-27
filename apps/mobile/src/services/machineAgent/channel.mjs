// The same NaCl box primitive used by Paseo. All authority-bearing fields are inside the box.
// Randomness is injected by platform adapters so Hermes never falls back to Math.random.
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

export const PROTOCOL = 'openchat.machine.v2';
export const REQUEST_LIFETIME = 5 * 60_000;
export const MAX_FRAME = 48_000;
export const MAX_PROMPT = 2_000;
export const MAX_RESULT = 6_000;
export const hex = (bytes) => Buffer.from(bytes).toString('hex');
export const validHex = (value, size) =>
  typeof value === 'string' && value.length === size * 2 && /^[0-9a-f]+$/.test(value);
function key(value) {
  if (!validHex(value, 32)) throw new Error('Invalid pairing key');
  return new Uint8Array(Buffer.from(value, 'hex'));
}
export function identity(random) {
  const pair = nacl.box.keyPair.fromSecretKey(key(hex(random(32))));
  return { publicKey: hex(pair.publicKey), secretKey: hex(pair.secretKey) };
}
function shared(secret, peer) {
  const sk = key(secret),
    pk = key(peer);
  if (nacl.scalarMult(sk, pk).every((byte) => byte === 0)) throw new Error('Invalid peer key');
  return nacl.box.before(pk, sk);
}
export function binding(grant) {
  return [PROTOCOL, grant.route, grant.machine, grant.device];
}
export function seal(grant, direction, secret, message, random) {
  const nonce = random(nacl.box.nonceLength);
  const body = Buffer.from(JSON.stringify([...binding(grant), direction, message]), 'utf8');
  const peer = direction === 'request' ? grant.machine : grant.device;
  const ciphertext = nacl.box.after(body, nonce, shared(secret, peer));
  const frame = Buffer.concat([nonce, ciphertext]).toString('base64');
  if (frame.length > MAX_FRAME) throw new Error('Message too large');
  return frame;
}
export function open(
  grant,
  direction,
  secret,
  frame,
  endpoint = direction === 'request' ? 'machine' : 'device',
) {
  if (
    typeof frame !== 'string' ||
    frame.length > MAX_FRAME ||
    frame.length < 56 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(frame)
  )
    throw new Error('Invalid frame');
  const bytes = Buffer.from(frame, 'base64');
  if (bytes.toString('base64') !== frame) throw new Error('Invalid encoding');
  const peer = endpoint === 'machine' ? grant.device : grant.machine;
  const plaintext = nacl.box.open.after(bytes.subarray(24), bytes.subarray(0, 24), shared(secret, peer));
  if (!plaintext) throw new Error('Unauthenticated frame');
  const fields = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  const expected = [...binding(grant), direction];
  if (!Array.isArray(fields) || fields.length !== 6 || !expected.every((v, i) => fields[i] === v))
    throw new Error('Incorrect channel');
  return fields[5];
}
export function parseOffer(text, device, now, account) {
  if (typeof text !== 'string' || text.length > 1500) throw new Error('Invalid machine offer');
  let fields;
  try {
    fields = JSON.parse(text);
  } catch {
    throw new Error('Invalid machine offer');
  }
  if (!Array.isArray(fields) || fields.length !== 10) throw new Error('Invalid machine offer');
  const [protocol, route, machine, client, token, until, owner, expires, deviceTicket, machineHash] = fields;
  if (
    owner !== account ||
    !validHex(deviceTicket, 32) ||
    !validHex(machineHash, 32) ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + 86400000 ||
    protocol !== PROTOCOL ||
    !validHex(route, 24) ||
    !validHex(machine, 32) ||
    client !== device ||
    !validHex(token, 32) ||
    !Number.isSafeInteger(until) ||
    until <= now ||
    until > now + 10 * 60_000
  )
    throw new Error('Offer expired or for another device');
  return { route, machine, device, token, until, deviceTicket, machineHash, expires };
}
