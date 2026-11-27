import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authority } from './authority.mjs';
import { checkScope, interruptDispatched, requireScoped, runReviewed } from './paseo.mjs';
import {
  identity,
  hex,
  parseOffer,
  seal,
  open,
} from '../../apps/mobile/src/services/machineAgent/channel.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'openchat-pair-'));
  const file = join(dir, 'private.db');
  let now = Date.now(),
    store = new Authority(file, () => now);
  const client = identity(randomBytes),
    agent = randomUUID();
  const { route, offer } = store.offer(client.publicKey, agent, dir, 'read-only', 'fixture');
  const g = parseOffer(offer, client.publicKey, now, 'fixture');
  store.db.prepare("UPDATE grants SET context='synthetic' WHERE route=?").run(route);
  const request = (action, n, body, id = hex(randomBytes(16))) => [action, n, id, now + 60_000, body];
  const frame = (message, s = client.secretKey, grant = g) => seal(grant, 'request', s, message, randomBytes);
  const admit = (message) => store.admit(route, frame(message));
  const decrypt = (result) => open(g, 'reply', client.secretKey, result.reply);
  const pair = () => admit(request('pair', 0, g.token));
  t.after(() => {
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });
  return {
    client,
    agent,
    g,
    dir,
    request,
    frame,
    admit,
    decrypt,
    pair,
    get store() {
      return store;
    },
    advance(ms) {
      now += ms;
    },
    restart() {
      store.close();
      store = new Authority(file, () => now);
    },
  };
}
test('only the operator-pinned private device key with the out-of-band token can activate once', (t) => {
  const f = fixture(t),
    a = identity(randomBytes);
  const pair = f.request('pair', 0, f.g.token);
  assert.throws(() => parseOffer(JSON.stringify(['bad']), a.publicKey, Date.now()));
  assert.equal(f.admit(f.request('turn', 1, 'before pair')), undefined);
  assert.equal(f.admit(f.request('pair', 0, hex(randomBytes(32)))), undefined);
  assert.throws(() => f.store.admit(f.g.route, f.frame(pair, a.secretKey)));
  assert.throws(() =>
    f.store.admit(f.g.route, f.frame(pair, f.client.secretKey, { ...f.g, route: hex(randomBytes(24)) })),
  );
  assert.throws(() => f.store.admit(f.g.route, JSON.stringify(pair)));
  const result = f.admit(pair);
  assert.equal(f.decrypt(result)[2], 'paired');
  assert.equal(f.store.grant(f.g.route).tokenHash, null);
  assert.deepEqual(f.admit(pair), result); // lost receipt, no second activation
  assert.equal(f.admit(f.request('pair', 0, f.g.token)), undefined);
  assert.throws(() => f.store.admit(f.g.route, result.reply)); // reflected reply
  assert.throws(() => f.frame(pair, f.client.secretKey, { ...f.g, machine: '0'.repeat(64) }));
});
test('expired offers and messages fail closed', (t) => {
  const f = fixture(t),
    pair = f.request('pair', 0, f.g.token);
  f.advance(600_001);
  assert.equal(f.admit(pair), undefined);
  assert.equal(f.admit(f.request('pair', 0, f.g.token)), undefined);
});
test('restart and reorder never dispatch an accepted message twice', (t) => {
  const f = fixture(t);
  f.pair();
  const req = f.request('turn', 3, 'private synthetic request');
  const wire = f.frame(req);
  assert.ok(!wire.includes(req[4]));
  const { job } = f.store.admit(f.g.route, wire);
  assert.equal(f.store.dispatch(job).item, job.id);
  assert.equal(f.store.dispatch(job), null);
  f.restart();
  assert.equal(f.decrypt(f.admit(req))[2], 'pending');
  assert.equal(f.admit(f.request('turn', 2, 'out of order')), undefined);
  assert.equal(f.admit(f.request('turn', 3, 'modified', job.id)), undefined);
  assert.equal(f.decrypt(f.admit(f.request('turn', 4, 'concurrent')))[2], 'busy');
  assert.equal(f.store.grant(f.g.route).stage, 'reserved');
  f.store.db
    .prepare(
      "UPDATE grants SET daemonTurn='owned',nativeThread='thread',nativeTurn='native',stage='native-terminal' WHERE route=?",
    )
    .run(job.route);
  f.store.db.prepare("INSERT INTO scoped_receipts VALUES(?,'owned')").run(job.route);
  const saved = f.store.finish(job, 'result', 'private synthetic answer', 'owned');
  assert.ok(!saved.includes('synthetic answer'));
  f.restart();
  assert.equal(f.admit(req).reply, saved);
  const probe = f.request('check', 3, job.id);
  assert.deepEqual(f.decrypt(f.admit(probe)).slice(0, 4), [
    3,
    probe[2],
    'result',
    'private synthetic answer',
  ]);
});
test('revocation survives restart and cancels waiting work and result retrieval', (t) => {
  const f = fixture(t);
  f.pair();
  const { job } = f.admit(f.request('turn', 1, 'pending'));
  f.store.revoke(f.g.route);
  f.restart();
  assert.equal(
    f.store.dispatch(job, () => assert.fail('revoked dispatch')),
    null,
  );
  assert.equal(f.store.finish(job, 'result', 'sensitive'), undefined);
  assert.equal(f.admit(f.request('check', 1, job.id)), undefined);
});
test('review expiry, unsolicited actions and a substituted scope are refused', async (t) => {
  const f = fixture(t);
  f.pair();
  for (const action of ['shell', 'forward', 'approve', 'autoReply', 'group', 'turn.create'])
    assert.equal(f.admit(f.request(action, 1, 'anything')), undefined);
  const { job } = f.admit(f.request('turn', 1, 'harmless'));
  const snap = {
    id: job.agent,
    cwd: job.workspace,
    provider: 'codex',
    currentModeId: 'read-only',
    status: 'idle',
  };
  for (const patch of [
    { cwd: '/' },
    { id: randomUUID() },
    { currentModeId: 'full-access' },
    { status: 'running' },
  ])
    assert.throws(() => checkScope({ ...snap, ...patch }, job));
  const sdk = {
    localApprovedTurn: async () => ({ version: 2, status: 'supported' }),
    agents: {
      ref: () => ({ refresh: async () => ({ agent: snap }), send: () => assert.fail('expired dispatch') }),
    },
  };
  const r = await runReviewed(
    f.store,
    sdk,
    job,
    async () => {
      f.advance(60_001);
      return true;
    },
    new AbortController().signal,
  );
  assert.equal(f.decrypt({ reply: r })[2], 'expired');
  f.advance(24 * 60 * 60_000);
  assert.equal(f.admit(f.request('check', 1, job.id)), undefined);
});
test('ambiguous submission, cancel rejection, and racing completion preserve the agent fence across restart', async (t) => {
  const f = fixture(t);
  f.pair();
  const { job } = f.admit(f.request('turn', 1, 'approved'));
  const req = f.store.dispatch(job);
  assert.equal(req.item, job.id);
  f.restart();
  assert.equal(f.store.grant(job.route).stage, 'reserved');
  f.store.revoke(job.route);
  let cancel;
  const sdk = {
    localApprovedTurn: async (input) => {
      cancel = input;
      return { version: 2, status: 'quarantined' };
    },
  };
  assert.equal(await interruptDispatched(f.store, sdk, job.route), false);
  assert.equal(cancel.item, job.id);
  assert.equal(f.store.finish(job, 'result', 'late result', 'unverified'), undefined);
  f.restart();
  assert.throws(
    () => f.store.offer(identity(randomBytes).publicKey, job.agent, job.workspace, job.mode, 'other'),
    /fresh agent/,
  );
});
test('literal lane refuses slash operations and requires causal evidence for a result', (t) => {
  const f = fixture(t);
  f.pair();
  for (const text of ['/goal pause', ' /compact', '/status'])
    assert.equal(f.decrypt(f.admit(f.request('turn', 1, text)))[2], 'denied');
  const { job } = f.admit(f.request('turn', 1, 'approved'));
  f.store.dispatch(job);
  const result = f.store.finish(job, 'result', 'unverified secret', 'other-turn');
  assert.equal(f.decrypt({ reply: result })[2], 'attention');
  assert.equal(f.store.grant(job.route).stage, 'quarantined');
});
test('an older SDK refuses before consent or submission', async (t) => {
  const f = fixture(t);
  f.pair();
  const { job } = f.admit(f.request('turn', 1, 'approved'));
  const frame = await runReviewed(
    f.store,
    {},
    job,
    () => assert.fail('unexpected consent'),
    new AbortController().signal,
  );
  assert.equal(f.decrypt({ reply: frame })[2], 'error');
});

test('transport sees a committed submission fence from another process connection', async (t) => {
  const f = fixture(t);
  f.pair();
  const { job } = f.admit(f.request('turn', 1, 'operator approved literal'));
  const observer = new Authority(join(f.dir, 'private.db'));
  t.after(() => observer.close());
  const snapshot = {
    id: job.agent,
    cwd: job.workspace,
    provider: 'codex',
    currentModeId: job.mode,
    status: 'idle',
  };
  const client = {
    agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) },
    localApprovedTurn: async (request) => {
      if (request.op === 'probe') return { version: 2, status: 'supported' };
      assert.equal(observer.grant(job.route).stage, 'reserved');
      observer.revoke(job.route);
      throw Error('Simulated lost transport after revocation');
    },
  };
  assert.equal(
    await runReviewed(f.store, client, job, async () => true, new AbortController().signal),
    undefined,
  );
  f.restart();
  assert.equal(f.store.grant(job.route).state, 'revoked');
  assert.equal(f.store.grant(job.route).reply, null);
  assert.equal(f.store.grant(job.route).stage, 'reserved');
});

test('legacy capability and receipts cannot establish a native turn binding', async (t) => {
  await assert.rejects(
    requireScoped({ localApprovedTurn: async () => ({ version: 1, status: 'supported' }) }),
  );
  const f = fixture(t);
  f.pair();
  const { job } = f.admit(f.request('turn', 1, 'legacy'));
  f.store.dispatch(job);
  f.store.db.prepare("UPDATE grants SET stage='terminal',daemonTurn='old' WHERE route=?").run(job.route);
  f.store.db.prepare("INSERT INTO scoped_receipts VALUES(?,'old')").run(job.route);
  assert.equal(
    open(f.g, 'reply', f.client.secretKey, f.store.finish(job, 'result', 'old plaintext', 'old'))[2],
    'attention',
  );
  f.store.db.exec('ALTER TABLE grants DROP COLUMN nativeThread; ALTER TABLE grants DROP COLUMN nativeTurn');
  f.restart();
  const g = f.store.grant(job.route);
  assert.equal(g.state, 'revoked');
  assert.equal(g.stage, 'quarantined');
  assert.equal(g.reply, null);
  assert.throws(() => f.store.offer(f.client.publicKey, f.agent, f.dir, 'auto', 'fixture'), /fresh agent/);
});
