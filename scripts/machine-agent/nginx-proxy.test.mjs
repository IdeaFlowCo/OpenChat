import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxProxyTrust } from '../../apps/server/src/services/nginxProxyTrust.ts';

test('Docker DNS refresh replaces the exact nginx peer, expires on time and stops on close', async t => {
  let at = 10_000;
  let v4 = '172.18.0.8';
  let ttl = 600;
  let lookupCalls = 0;
  let release;
  const lookup = async family => {
    lookupCalls++;
    if (family === 6) throw Object.assign(new Error(), { code: 'ENODATA' });
    await new Promise(resolve => { release = resolve; });
    return [{ address: v4, ttl }];
  };
  const proxy = createNginxProxyTrust('noos_nginx', lookup, () => at);
  t.after(proxy.close);
  assert.equal(proxy.trust(v4, 0), false);
  const first = proxy.refresh();
  assert.equal(first, proxy.refresh());
  assert.equal(lookupCalls, 2);
  release();
  await first;
  assert.equal(proxy.trust('::ffff:172.18.0.8', 0), true);
  assert.equal(proxy.trust(v4, 1), false);
  const inFlight = proxy.refresh();
  at += 5_000;
  // A late positive answer cannot extend trust for the time it spent in flight.
  assert.equal(proxy.trust(v4, 0), false);
  release();
  await inFlight;
  assert.equal(proxy.trust(v4, 0), false);
  v4 = '172.18.0.9';
  ttl = 1;
  const next = proxy.refresh();
  release();
  await next;
  assert.equal(proxy.trust('172.18.0.8', 0), false);
  assert.equal(proxy.trust(v4, 0), true);
  at += 1_000;
  assert.equal(proxy.trust(v4, 0), false);
  const closing = proxy.refresh();
  proxy.close();
  release();
  await closing;
  assert.equal(proxy.trust(v4, 0), false);
});

test('failed, malformed or ambiguous DNS replies disable both families until fresh resolution', async t => {
  let answer = [{ address: '172.18.0.8', ttl: 600 }];
  const proxy = createNginxProxyTrust('noos_nginx', async family => {
    if (family === 6) return [{ address: 'fd00::8', ttl: 60 }];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  t.after(proxy.close);
  for (const bad of [new Error('timeout'), Object.assign(new Error(), { code: 'ENOTFOUND' }),
    [{ address: '127.0.0.1/8', ttl: 60 }], [{ address: '172.18.0.8', ttl: 0 }],
    [{ address: '172.18.0.8', ttl: 60 }, { address: '172.18.0.9', ttl: 60 }]]) {
    answer = [{ address: '172.18.0.8', ttl: 600 }];
    await proxy.refresh();
    assert.equal(proxy.trust('fd00::8', 0), true);
    assert.equal(proxy.trust('172.18.0.8', 0), true);
    answer = bad;
    await proxy.refresh();
    assert.equal(proxy.trust('fd00::8', 0), false);
    assert.equal(proxy.trust('172.18.0.8', 0), false);
  }
  assert.throws(() => createNginxProxyTrust('172.18.0.1'), /must be noos_nginx/);
  const off = createNginxProxyTrust('', async () => assert.fail('disabled configuration queried DNS'));
  await off.refresh();
  assert.equal(off.trust('172.18.0.8', 0), false);
  off.close();
});
