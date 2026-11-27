import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MAX_PROMPT,
  MAX_RESULT,
  PROTOCOL,
  REQUEST_LIFETIME,
  hex,
  identity,
  open,
  seal,
  validHex,
} from '../../apps/mobile/src/services/machineAgent/channel.mjs';

export const hash = (text) => createHash('sha256').update(text).digest('hex');
const empty = 'Delivery uncertain. Check this turn on the machine before sending again.';
export class Authority {
  constructor(file, clock = Date.now) {
    this.now = clock;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS machine (id INTEGER PRIMARY KEY CHECK(id=1), pub TEXT NOT NULL, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (
        route TEXT PRIMARY KEY, device TEXT NOT NULL, agent TEXT NOT NULL, workspace TEXT NOT NULL, mode TEXT NOT NULL,
        tokenHash TEXT, offerUntil INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT -1, request TEXT, digest TEXT, reply TEXT, stage TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bound_agent ON grants(agent) WHERE state != 'revoked' OR stage = 'sent';`);
    this.transaction(() => {
      const columns = this.db
        .prepare('PRAGMA table_info(grants)')
        .all()
        .map((c) => c.name);
      if (!columns.includes('relayTicket')) {
        this.db.exec(
          "ALTER TABLE grants ADD COLUMN relayTicket TEXT; UPDATE grants SET state='revoked',reply=NULL,tokenHash=NULL; UPDATE grants SET stage='quarantined' WHERE stage IN ('sent','review');",
        );
      }
      const fields = this.db
        .prepare('PRAGMA table_info(grants)')
        .all()
        .map((c) => c.name);
      for (const [name, type] of [
        ['localProof', 'TEXT'],
        ['context', 'TEXT'],
        ['daemonTurn', 'TEXT'],
        ['approvedHash', 'TEXT'],
        ['deadline', 'INTEGER'],
      ]) {
        if (!fields.includes(name)) this.db.exec('ALTER TABLE grants ADD COLUMN ' + name + ' ' + type);
      }
      this.db.exec(
        "UPDATE grants SET localProof=lower(hex(randomblob(32))) WHERE localProof IS NULL AND state='revoked'",
      );
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS scoped_receipts(route TEXT NOT NULL, turn TEXT NOT NULL, PRIMARY KEY(route,turn))',
      );
    });
    const key = identity(randomBytes);
    this.db.prepare('INSERT OR IGNORE INTO machine VALUES(1,?,?)').run(key.publicKey, key.secretKey);
    this.machine = this.db.prepare('SELECT * FROM machine WHERE id=1').get();
  }
  grant(route) {
    return this.db.prepare('SELECT * FROM grants WHERE route=?').get(route);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  offer(device, agent, workspace, mode, owner) {
    if (
      typeof owner !== 'string' ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(owner) ||
      !['read-only', 'auto'].includes(mode) ||
      !validHex(device, 32) ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(agent) ||
      !workspace.startsWith('/')
    )
      throw Error('Invalid local scope');
    const token = hex(randomBytes(32)),
      now = this.now();
    const until = now + 10 * 60_000,
      expires = now + 24 * 60 * 60_000;
    const deviceTicket = hex(randomBytes(32)),
      machineTicket = hex(randomBytes(32)),
      machineHash = hash(machineTicket);
    const route = hash(
      JSON.stringify(['openchat.relay.v2', owner, expires, machineHash, hash(deviceTicket)]),
    ).slice(0, 48);
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM grants WHERE agent=?').get(agent))
        throw Error('Use a fresh agent for each grant');
      this.db
        .prepare(
          "INSERT INTO grants(route,device,agent,workspace,mode,tokenHash,offerUntil,expires,relayTicket,localProof,state) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')",
        )
        .run(
          route,
          device,
          agent,
          workspace,
          mode,
          hash(token),
          until,
          expires,
          machineTicket,
          hex(randomBytes(32)),
        );
    });
    return {
      route,
      offer: JSON.stringify([
        PROTOCOL,
        route,
        this.machine.pub,
        device,
        token,
        until,
        owner,
        expires,
        deviceTicket,
        machineHash,
      ]),
    };
  }
  revoke(route) {
    return this.transaction(() => {
      const g = this.grant(route);
      if (!g) return null;
      this.db.prepare("UPDATE grants SET state='revoked',tokenHash=NULL,reply=NULL WHERE route=?").run(route);
      return g;
    });
  }
  allowed(row, seq, id) {
    return row && row.state === 'active' && row.expires > this.now() && row.seq === seq && row.request === id;
  }
  response(g, n, id, status, text) {
    return seal(
      { ...g, machine: this.machine.pub },
      'reply',
      this.machine.secret,
      [n, id, status, text, g.expires],
      randomBytes,
    );
  }
  readReceipt(g) {
    // The receipt is encrypted to the device. The machine derives the same shared key
    // using its own secret and the pinned device key to read it for a fresh status check.
    return open({ ...g, machine: this.machine.pub }, 'reply', this.machine.secret, g.reply, 'machine');
  }
  admit(route, wire) {
    return this.transaction(() => {
      const g = this.grant(route),
        now = this.now();
      if (!g || g.state === 'revoked' || now >= g.expires) return;
      const data = open({ ...g, machine: this.machine.pub }, 'request', this.machine.secret, wire);
      if (!Array.isArray(data) || data.length !== 5) return;
      const [action, n, id, until, body] = data;
      if (
        !Number.isSafeInteger(n) ||
        n < 0 ||
        !validHex(id, 16) ||
        !Number.isSafeInteger(until) ||
        until <= now ||
        until > now + REQUEST_LIFETIME ||
        typeof body !== 'string'
      )
        return;
      const reply = (status, text) => ({ reply: this.response(g, n, id, status, text) });
      if (action === 'check' && validHex(body, 16) && g.state === 'active') {
        if (n !== g.seq || body !== g.request)
          return reply('unknown', 'The machine has no current receipt for this turn.');
        if (!g.reply)
          return reply(
            'pending',
            g.stage === 'review'
              ? 'Waiting for the machine operator. After a host restart, review the local agent.'
              : empty,
          );
        const [, , status, text] = this.readReceipt(g);
        return reply(status, text);
      }
      const digest = hash(JSON.stringify(data));
      if (g.seq === n && g.request === id && g.digest === digest) {
        return g.reply ? { reply: g.reply } : reply('pending', empty);
      }
      if (
        action === 'pair' &&
        n === 0 &&
        g.state === 'pending' &&
        g.context &&
        g.offerUntil > now &&
        validHex(body, 32) &&
        timingSafeEqual(Buffer.from(hash(body), 'hex'), Buffer.from(g.tokenHash, 'hex'))
      ) {
        const frame = this.response(g, n, id, 'paired', 'Device paired. The machine reviews each message.');
        this.db
          .prepare(
            "UPDATE grants SET state='active',tokenHash=NULL,seq=0,request=?,digest=?,reply=? WHERE route=?",
          )
          .run(id, digest, frame, route);
        return { reply: frame };
      }
      if (action !== 'turn' || g.state !== 'active' || n <= g.seq || !body.trim() || body.length > MAX_PROMPT)
        return;
      if (/^\s*\//u.test(body)) return reply('denied', 'Only a literal agent message can be approved.');
      if (g.stage && g.stage !== 'done') return reply('busy', empty);
      // Reserve durably before any prompt, provider call or crash. A duplicate never redispatches.
      this.db
        .prepare(
          "UPDATE grants SET seq=?,request=?,digest=?,stage='review',reply=NULL,daemonTurn=NULL,approvedHash=NULL,deadline=NULL WHERE route=?",
        )
        .run(n, id, digest, route);
      return {
        job: { route, agent: g.agent, workspace: g.workspace, mode: g.mode, id, n, text: body, until },
      };
    });
  }
  dispatch(job) {
    return this.transaction(() => {
      const g = this.grant(job.route);
      if (!this.allowed(g, job.n, job.id) || !g.context || g.stage !== 'review' || this.now() >= job.until)
        return null;
      this.db
        .prepare("UPDATE grants SET stage='reserved',approvedHash=?,deadline=? WHERE route=?")
        .run(hash(job.text), job.until, job.route);
      return { route: job.route, proof: g.localProof, item: job.id, text: job.text };
    });
  }
  finish(job, status, text, turnId) {
    return this.transaction(() => {
      const g = this.grant(job.route);
      if (!this.allowed(g, job.n, job.id)) return;
      if (
        status === 'result' &&
        !(
          turnId &&
          g.stage === 'terminal' &&
          g.daemonTurn === turnId &&
          this.db.prepare('SELECT 1 FROM scoped_receipts WHERE route=? AND turn=?').get(job.route, turnId)
        )
      ) {
        status = 'attention';
        text = empty;
      }
      const frame = this.response(g, job.n, job.id, status, text.slice(0, MAX_RESULT));
      const stage = status === 'result' || g.stage === 'review' ? 'done' : 'quarantined';
      this.db.prepare('UPDATE grants SET stage=?,reply=? WHERE route=?').run(stage, frame, job.route);
      return frame;
    });
  }
  close() {
    this.db.close();
  }
}
