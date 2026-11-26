import { io } from 'socket.io-client';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { OPENCHAT_URL, getAuthenticatedToken, getUser } from '../../api/client';
import {
  identity,
  hex,
  parseOffer,
  open,
  seal,
  MAX_RESULT,
  REQUEST_LIFETIME,
  type Grant,
  type Identity,
} from './channel.mjs';

const random = (length: number) => Crypto.getRandomValues(new Uint8Array(length));
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
interface Receipt {
  seq: number;
  id: string;
  until: number;
  settled: boolean;
}
interface Device {
  key: Identity;
  grant?: Grant;
  token?: string;
  expires?: number;
  receipt?: Receipt;
}
function storage(account: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(account)) throw Error('Invalid local account');
  return 'machine.agent.v1.' + account;
}
async function save(account: string, device: Device) {
  await SecureStore.setItemAsync(storage(account), JSON.stringify(device), options);
}
async function load(account: string): Promise<Device> {
  if (!(await SecureStore.isAvailableAsync())) throw Error('Secure device storage is unavailable.');
  const raw = await SecureStore.getItemAsync(storage(account), options);
  if (raw) return JSON.parse(raw) as Device;
  const device = { key: identity(random) };
  await save(account, device);
  return device;
}
// Serialize allocation, write-before-send and key replacement across mounted screens.
const owners = new Set<string>();
async function exclusive<T>(account: string, work: () => Promise<T>) {
  if (owners.has(account)) throw Error('Another machine request is open.');
  owners.add(account);
  try {
    return await work();
  } finally {
    owners.delete(account);
  }
}
export function describeMachine(account: string) {
  return exclusive(account, async () => {
    const d = await load(account);
    return {
      publicKey: d.key.publicKey,
      machine: d.grant?.machine,
      expires: d.expires,
      pending: !!d.token,
      last: !!d.receipt,
    };
  });
}
export function forgetMachine(account: string) {
  return exclusive(account, () => SecureStore.deleteItemAsync(storage(account), options));
}
type Reply = { status: string; text: string; expires: number };
async function exchange(
  account: string,
  grant: Grant,
  secret: string,
  payload: unknown[],
  receipt: Receipt,
  signal: AbortSignal,
): Promise<Reply> {
  const token = await getAuthenticatedToken();
  if (!token || (await getUser())?.userId !== account) throw Error('Sign in to this OpenChat account again.');
  const frame = seal(grant, 'request', secret, payload, random);
  if (signal.aborted) throw Error('Machine view closed.');
  return new Promise((resolve, reject) => {
    const socket = io(OPENCHAT_URL + '/machine-agent-v1', {
      forceNew: true,
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      auth: { route: grant.route, side: 'device', token },
    });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      socket.removeAllListeners();
      socket.disconnect();
    };
    const cancel = () => {
      done();
      reject(
        Error(
          'No verified machine reply. The listener may be offline or the grant revoked. Check last turn after reconnecting.',
        ),
      );
    };
    const timer = setTimeout(cancel, 18_000);
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('connect_error', cancel);
    socket.on('disconnect', cancel);
    socket.on('connect', () => {
      socket.emit('frame', frame, (delivered: unknown) => {
        if (delivered !== true) {
          done();
          reject(Error('Machine offline. Start the local machine listener.'));
        }
      });
    });
    socket.on('frame', (wire: unknown) => {
      let value: unknown;
      try {
        value = open(grant, 'reply', secret, wire);
      } catch {
        return;
      }
      if (!Array.isArray(value) || value.length !== 5) return;
      const [seq, id, status, text, expires] = value;
      if (
        !Number.isSafeInteger(expires) ||
        seq !== receipt.seq ||
        id !== receipt.id ||
        typeof status !== 'string' ||
        typeof text !== 'string' ||
        text.length > MAX_RESULT ||
        !['paired', 'result', 'denied', 'expired', 'attention', 'error', 'unknown', 'busy', 'pending'].includes(
          status,
        )
      )
        return;
      done();
      resolve({ status, text, expires });
    });
    socket.connect();
  });
}
export function machineRequest(
  account: string,
  kind: 'pair' | 'turn' | 'check',
  value: string,
  signal: AbortSignal,
) {
  return exclusive(account, async () => {
    const d = await load(account),
      now = Date.now();
    let action = kind;
    if (action === 'pair') {
      if (d.grant && !d.token) throw Error('Forget the current machine before pairing another.');
      const g = parseOffer(value, d.key.publicKey, now);
      if (d.grant && d.grant.route !== g.route) throw Error('Forget the pending offer before replacing it.');
      d.grant = { route: g.route, machine: g.machine, device: g.device };
      d.token = g.token;

      d.receipt ??= {
        seq: 0,
        id: hex(random(16)),
        until: Math.min(g.until, now + REQUEST_LIFETIME),
        settled: false,
      };
    }
    if (!d.grant) throw Error('Pair this device first.');
    if (d.expires && now >= d.expires) throw Error('Machine grant expired. Forget it and request a new offer.');
    if (action === 'check' && d.token) action = 'pair';
    if (action === 'turn') {
      if (d.token) throw Error('Complete pairing first.');
      if (!value.trim() || value.length > 2000) throw Error('Enter a message of 1–2,000 characters.');
      if (d.receipt && !d.receipt.settled) throw Error('Check the previous turn before sending another.');
      d.receipt = {
        seq: (d.receipt?.seq ?? 0) + 1,
        id: hex(random(16)),
        until: now + REQUEST_LIFETIME,
        settled: false,
      };
    }
    if (!d.receipt || (action === 'pair' && now >= d.receipt.until))
      throw Error('Offer expired. Forget it and request another on the machine.');
    if (signal.aborted) throw Error('Machine view closed.');
    await save(account, d);
    const r = d.receipt;
    const expiry = action === 'check' ? now + REQUEST_LIFETIME : r.until;
    const query = action === 'check' ? { ...r, id: hex(random(16)) } : r;
    const body = action === 'pair' ? d.token : action === 'turn' ? value : r.id;
    const response = await exchange(
      account,
      d.grant,
      d.key.secretKey,
      [action, r.seq, query.id, expiry, body],
      query,
      signal,
    );
    if (response.status === 'paired' && r.seq === 0) {
      delete d.token;
      d.expires = response.expires;
    }
    if (
      ['paired', 'result', 'denied', 'expired', 'attention', 'error', 'busy'].includes(response.status) ||
      (response.status === 'unknown' && now >= r.until)
    )
      r.settled = true;
    await save(account, d);
    return response.text;
  });
}
