import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authority } from './authority.mjs';
import { checkScope, extractReply, runReviewed } from './paseo.mjs';
import { identity, hex, parseOffer, seal, open } from '../../apps/mobile/src/services/machineAgent/channel.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'openchat-pair-'));
  const file = join(dir, 'private.db');
  let now = Date.now(),
    store = new Authority(file, () => now);
  const client = identity(randomBytes),
    agent = randomUUID();
  const { route, offer } = store.offer(client.publicKey, agent, dir);
  const g = parseOffer(offer, client.publicKey, now);
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
  let calls = 0;
  const start = () => {
    calls++;
    return Promise.resolve();
  };
  f.store.dispatch(job, start);
  assert.equal(f.store.dispatch(job, start), null);
  f.restart();
  assert.equal(f.decrypt(f.admit(req))[2], 'pending');
  assert.equal(f.admit(f.request('turn', 2, 'out of order')), undefined);
  assert.equal(f.admit(f.request('turn', 3, 'modified', job.id)), undefined);
  assert.equal(f.decrypt(f.admit(f.request('turn', 4, 'concurrent')))[2], 'busy');
  const saved = f.store.finish(job, 'result', 'private synthetic answer');
  assert.ok(!saved.includes('synthetic answer'));
  f.restart();
  assert.equal(f.admit(req).reply, saved);
  const probe = f.request('check', 3, job.id);
  assert.deepEqual(f.decrypt(f.admit(probe)).slice(0, 4), [3, probe[2], 'result', 'private synthetic answer']);
  assert.equal(calls, 1);
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
test('result requires exact agent, request identity and same turn', (t) => {
  const f = fixture(t);
  f.pair();
  const { job } = f.admit(f.request('turn', 1, 'bounded'));
  const one = {
    seqEnd: 1,
    turnId: 'turn',
    item: { type: 'user_message', clientMessageId: job.id, text: job.text },
  };
  const two = { seqStart: 2, turnId: 'turn', item: { type: 'assistant_message', text: 'answer' } };
  const page = { agentId: job.agent, entries: [one, two] };
  assert.equal(extractReply(page, job), 'answer');
  for (const other of [
    { ...page, agentId: randomUUID() },
    { ...page, entries: [one, { ...two, turnId: 'other' }] },
    { ...page, entries: [one, two, { ...one, item: { ...one.item, clientMessageId: 'else' } }] },
  ])
    assert.throws(() => extractReply(other, job));
});
