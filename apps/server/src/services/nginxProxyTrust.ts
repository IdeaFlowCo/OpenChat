import { Resolver } from 'node:dns/promises';
import type { RecordWithTtl } from 'node:dns';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';

const proxyAddr = createRequire(import.meta.url)('proxy-addr') as {
  compile(addresses: string[]): (address: string) => boolean;
};

export type ProxyTrust = (peer: string, hop: number) => boolean;
type Lookup = (family: 4 | 6) => Promise<RecordWithTtl[]>;
const disabled: ProxyTrust = () => false;
const maxAgeMs = 5_000;
const refreshMs = 1_000;

function dockerLookup(): Lookup {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  resolver.setServers(['127.0.0.11']);
  return family => family === 4
    ? resolver.resolve4('noos_nginx', { ttl: true })
    : resolver.resolve6('noos_nginx', { ttl: true });
}

async function records(lookup: Lookup, family: 4 | 6) {
  try {
    const result = await lookup(family);
    if (result.length > 1 || result.some(r => isIP(r.address) !== family || r.address.includes('%')
      || !Number.isSafeInteger(r.ttl) || r.ttl <= 0))
      throw Error('Ambiguous nginx DNS response');
    return result;
  } catch (error) {
    // One address family may be absent on an otherwise healthy Docker network.
    if ((error as NodeJS.ErrnoException)?.code === 'ENODATA') return [];
    throw error;
  }
}

/** Express calls this trust predicate synchronously. Refresh outside the request
 * path, and expire by monotonic time even when timers or DNS responses are late. */
export function createNginxProxyTrust(
  configuredName: string | undefined,
  lookup?: Lookup,
  now: () => number = () => performance.now(),
) {
  if (!configuredName) return { trust: disabled, refresh: async () => {}, close() {} };
  if (configuredName !== 'noos_nginx') throw Error('OPENCHAT_TRUSTED_PROXY must be noos_nginx');
  const resolve = lookup ?? dockerLookup();
  let matches: (peer: string) => boolean = () => false;
  let expires = 0;
  let closed = false;
  let pending: Promise<void> | undefined;
  async function update() {
    const started = now();
    try {
      const [v4, v6] = await Promise.all([records(resolve, 4), records(resolve, 6)]);
      const addresses = [...v4, ...v6];
      if (closed || !addresses.length) { expires = 0; return; }
      matches = proxyAddr.compile(addresses.map(r => r.address));
      expires = started + Math.min(maxAgeMs, ...addresses.map(r => r.ttl * 1_000));
    } catch {
      expires = 0;
    }
  }
  function refresh() {
    if (closed) return Promise.resolve();
    pending ??= update().finally(() => { pending = undefined; });
    return pending;
  }
  void refresh();
  const timer = setInterval(refresh, refreshMs).unref();
  const trust: ProxyTrust = (peer, hop) => hop === 0 && now() < expires && Boolean(isIP(peer)) && matches(peer);
  return { trust, refresh, close() { closed = true; expires = 0; clearInterval(timer); } };
}
