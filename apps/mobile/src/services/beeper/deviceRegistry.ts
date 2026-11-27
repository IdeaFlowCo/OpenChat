import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { getUser } from '../../api/client';
import { installReviewedBeeperReadResolver, BeeperSecureGrantRequired } from './readIntent';
import {
  protocol,
  audience,
  destination,
  isHex,
  openReadEnvelope,
  sealReadEnvelope,
  validSelection,
  sameSelection,
  type Selection,
} from './readProtocol.mjs';

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const unavailable = (): never => {
  throw new BeeperSecureGrantRequired();
};
const field = (account: string, route: string, chat: string) => {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(account) || !isHex(route, 48) || !isHex(chat, 64)) return unavailable();
  return 'beeper.read.v1.' + account + '.' + route + '.' + chat;
};
type Display = { title: string; chatType: 'direct' | 'group'; network?:'whatsapp'|'imessage' };
function validDisplay(display: Display | undefined): display is Display {
  return (
    !!display &&
    typeof display.title === 'string' &&
    !!display.title.trim() &&
    display.title.length <= 200 &&
    ['direct', 'group'].includes(display.chatType) &&
    (display.network === undefined || ['whatsapp','imessage'].includes(display.network))
  );
}
type Entry = {
  selection: Selection;
  display: Display;
  sequence: number;
  last?: { jobId: string; epoch: number; kind: string; hash: string; until: number };
};
const active = new Set<string>();
async function exclusive<T>(key: string, work: () => Promise<T>) {
  if (active.has(key)) return unavailable();
  active.add(key);
  try {
    return await work();
  } finally {
    active.delete(key);
  }
}
async function pair(account: string) {
  if (
    !/^[A-Za-z0-9_-]{1,120}$/.test(account) ||
    (await getUser())?.userId !== account ||
    !(await SecureStore.isAvailableAsync())
  )
    return unavailable();
  const raw = await SecureStore.getItemAsync('machine.agent.v1.' + account, options);
  if (!raw) return unavailable();
  const d = JSON.parse(raw);
  if (
    d.token ||
    !isHex(d.key?.publicKey, 64) ||
    !isHex(d.key?.secretKey, 64) ||
    d.key.publicKey !== d.grant?.device ||
    !isHex(d.grant.machine, 64) ||
    !isHex(d.grant.route, 48) ||
    !isHex(d.grant.deviceTicket, 64) ||
    !Number.isSafeInteger(d.expires) ||
    d.expires <= Date.now()
  )
    return unavailable();
  return {
    deviceKey: d.key.publicKey as string,
    machineKey: d.grant.machine as string,
    secret: d.key.secretKey as string,
    route: d.grant.route as string,
    expires: d.expires as number,
  };
}
function current(s: Selection, p: Awaited<ReturnType<typeof pair>>, account: string) {
  return (
    validSelection(s) &&
    s.ownerId === account &&
    s.machineKey === p.machineKey &&
    s.deviceKey === p.deviceKey &&
    s.pairRoute === p.route &&
    s.expiresAt <= p.expires &&
    s.expiresAt > Date.now()
  );
}
// Called only from an explicit local grant-import action. The sealed offer is
// from the paired Mac and carries the destination and selected source.
export async function acceptBeeperReadOffer(
  account: string,
  wire: string,
  confirm: (scope: Readonly<Selection & Display>) => Promise<boolean>,
) {
  const p = await pair(account),
    offer = openReadEnvelope(p, 'grant', wire, p.secret) as { scope?: unknown; display?: Display };
  const s = offer?.scope,
    display = offer?.display;
  if (!validDisplay(display) || !validSelection(s) || !current(s, p, account)) return unavailable();
  const key = field(account, s.route, s.chatKey);
  return exclusive(key, async () => {
    if (!(await confirm(Object.freeze({ ...s, ...display }))) || !current(s, await pair(account), account))
      return unavailable();
    const existing = await SecureStore.getItemAsync(key, options);
    if (existing) {
      const entry = JSON.parse(existing) as Entry;
      if (entry.selection.grantId === s.grantId) return;
    }
    await SecureStore.setItemAsync(key, JSON.stringify({ selection: s, display, sequence: 0 }), options);
  });
}
// The caller explicitly enables this resolver for the signed-in native account.
// Reading a relay response or importing this module does not install a signer.
export function enableBeeperReadRegistry(account: string) {
  let enabled = true;
  const clear = installReviewedBeeperReadResolver(async (scope) => {
    const key = field(account, scope.route, scope.chatKey);
    const read = async () => {
      const value = await SecureStore.getItemAsync(key, options);
      if (!value) return unavailable();
      const entry = JSON.parse(value) as Entry,
        p = await pair(account),
        s = entry.selection;
      if (
        !enabled ||
        !validDisplay(entry.display) ||
        !current(s, p, account) ||
        Object.entries(scope).some(([k, v]) => s[k as keyof Selection] !== v)
      )
        return unavailable();
      return { entry, p, s };
    };
    const first = await read(),
      initial = first.s;
    return {
      ...initial,
      display: first.entry.display,
      sealRead: (req) =>
        exclusive(key, async () => {
          const { entry, p, s } = await read(),
            now = Date.now();
          if (
            !sameSelection(initial, s) ||
            req.protocol !== protocol ||
            req.audience !== audience ||
            req.destination !== destination ||
            req.operation !== 'readSelected' ||
            req.connectionId !== s.route ||
            req.grantId !== s.grantId ||
            ['ownerId','route', 'machineKey', 'deviceKey', 'accountKey', 'chatKey'].some(
              (k) => req[k] !== s[k as keyof Selection],
            ) ||
            !isHex(req.jobId, 48) ||
            !isHex(req.requestId, 32) ||
            !Number.isSafeInteger(req.epoch) ||
            Number(req.epoch) < 1 ||
            !['open', 'earlier', 'refresh'].includes(String(req.kind)) ||
            !Number.isSafeInteger(req.expiresAt) ||
            Number(req.expiresAt) <= now ||
            Number(req.expiresAt) > Math.min(s.expiresAt, now + 300000)
          )
            return unavailable();
          if (entry.last?.jobId === req.jobId) {
            if (entry.last.epoch !== req.epoch || entry.last.kind !== req.kind || entry.last.until <= now)
              return unavailable();
            const prefix = key + '.' + (entry.sequence % 2) + '.';
            const [first, second] = await Promise.all(
              [0, 1].map((i) => SecureStore.getItemAsync(prefix + i, options)),
            );
            if (first === null || second === null) return unavailable();
            const frame = first + second;
            if (
              (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, frame)) !== entry.last.hash
            )
              return unavailable();
            if (!enabled || !current(s, await pair(account), account)) return unavailable();
            return frame;
          }
          if (
            !Number.isSafeInteger(entry.sequence) ||
            entry.sequence < 0 ||
            entry.sequence >= Number.MAX_SAFE_INTEGER
          )
            return unavailable();
          const sequence = entry.sequence + 1;
          const until = Math.min(Number(req.expiresAt), now + 240000);
          const signed = {
            ...s,
            operation: 'readSelected',
            connectionId: s.route,
            jobId: req.jobId,
            epoch: req.epoch,
            requestId: req.requestId,
            kind: req.kind,
            sequence,
            until,
          };
          const frame = sealReadEnvelope(p, 'read', signed, p.secret, (n) =>
            Crypto.getRandomValues(new Uint8Array(n)),
          );
          if (frame.length > 3200) return unavailable();
          const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, frame);
          const prefix = key + '.' + (sequence % 2) + '.';
          await SecureStore.setItemAsync(prefix + '0', frame.slice(0, 1600), options);
          await SecureStore.setItemAsync(prefix + '1', frame.slice(1600), options);
          await SecureStore.setItemAsync(
            key,
            JSON.stringify({
              selection: s,
              display: entry.display,
              sequence,
              last: { jobId: req.jobId, epoch: req.epoch, kind: req.kind, until, hash },
            }),
            options,
          );
          if (!enabled || !current(s, await pair(account), account)) return unavailable();
          return frame;
        }),
    };
  });
  return () => {
    enabled = false;
    clear();
  };
}
