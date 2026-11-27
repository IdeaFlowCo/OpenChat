import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { opaqueBeeperNetworkKey, catalogueEntry, importBatch } from './desktopApi.mjs';
import {
  audience,
  protocol,
  destination,
  isHex,
  openReadEnvelope,
  sealReadEnvelope,
  validSelection,
  sameSelection,
} from '../../apps/mobile/src/services/beeper/readProtocol.mjs';

export class BeeperLocalApprovalError extends Error {
  constructor() {
    super('Local Beeper read approval is unavailable or changed');
    this.code = 'local_approval_required';
  }
}
const reject = () => {
  throw new BeeperLocalApprovalError();
};
const sha = (v) => createHash('sha256').update(v).digest('hex');
const id = () => randomBytes(24).toString('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v !== null && typeof v === 'object'
    ? '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    : JSON.stringify(v);
const validId = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(v);
const digest = (payload, final) => sha(canonical({ payload, final }));
function privatePath(path, dir) {
  const st = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    st.uid !== process.getuid() ||
    st.mode & 0o077 ||
    (dir ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)
  )
    reject();
}
export async function confirmBeeperLocally(summary) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const io = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await io.question(
        JSON.stringify(summary).replace(
          /[^\x20-\x7e]/g,
          (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
        ) + '\nType approve to authorize this disclosure: ',
      )) === 'approve'
    );
  } finally {
    io.close();
  }
}
function chunks(chat, page, mapping) {
  if (!page || !Array.isArray(page.items) || page.items.length > 2000 || typeof page.hasMore !== 'boolean')
    reject();
  const out = [];
  function add(items) {
    let payload;
    try {
      payload = importBatch(chat, { ...page, items }, mapping).payload;
    } catch (error) {
      if (items.length <= 1) throw error;
    }
    if (payload && Buffer.byteLength(JSON.stringify(payload)) <= 950000) {
      out.push(payload);
      return;
    }
    if (items.length <= 1) reject();
    const middle = Math.ceil(items.length / 2);
    add(items.slice(0, middle));
    add(items.slice(middle));
  }
  for (let n = 0; n < page.items.length; n += 100) add(page.items.slice(n, n + 100));
  if (!out.length) add([]);
  return out;
}
const readFields = [
  'protocol',
  'audience',
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
  'operation',
  'connectionId',
  'jobId',
  'epoch',
  'requestId',
  'kind',
  'sequence',
  'until',
]
  .sort()
  .join(',');
export class BeeperReadAuthority {
  #db;
  #platform;
  constructor({ directory, pairingDirectory, clock = Date.now, platform = process.platform }) {
    privatePath(pairingDirectory, true);
    const paired = join(pairingDirectory, 'authority.db');
    privatePath(paired, false);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    const file = join(directory, 'beeper-read.db');
    if (!existsSync(file)) {
      try {
        closeSync(openSync(file, 'wx', 0o600));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    privatePath(file, false);
    this.clock = clock;
    this.#platform = platform;
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    this.#db.prepare('ATTACH DATABASE ? AS paired').run(paired);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), key BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS catalogues(route TEXT PRIMARY KEY, owner TEXT NOT NULL, pairRoute TEXT NOT NULL, device TEXT NOT NULL,machine TEXT NOT NULL,accountId TEXT NOT NULL,accountKey TEXT NOT NULL,grantId TEXT NOT NULL,expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,cursor TEXT);
      CREATE TABLE IF NOT EXISTS selections(id TEXT PRIMARY KEY,route TEXT NOT NULL,chatKey TEXT NOT NULL,chat TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,oldest TEXT,newest TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_selection ON selections(route,chatKey) WHERE revoked=0;
      CREATE TABLE IF NOT EXISTS operations(job TEXT PRIMARY KEY,grantId TEXT NOT NULL,request TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,kind TEXT NOT NULL,until INTEGER NOT NULL,phase TEXT NOT NULL,cursor TEXT,direction TEXT NOT NULL,oldest TEXT,newest TEXT,chatId TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_read ON operations(grantId) WHERE phase IN ('reserved','reading','staged');
      CREATE TABLE IF NOT EXISTS batches(job TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT,digest TEXT NOT NULL,final INTEGER NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,attempted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job,sequence));`);
    // Local revoke intentionally bypasses the worker lease. Serialize schema
    // inspection AND migration with the same SQLite write lock as revocation.
    this.#tx(() => {
      if (!this.#db.prepare('PRAGMA table_info(catalogues)').all().some(column => column.name === 'network'))
        this.#db.exec("ALTER TABLE catalogues ADD COLUMN network TEXT NOT NULL DEFAULT 'whatsapp'");
    });
    this.#db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?)').run(randomBytes(32));
  }
  close() {
    this.#db.close();
  }
  #tx(fn) {
    // Both attached private databases are locked, including the machine owner's revoke ledger.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #pairing(pairRoute) {
    const p = this.#db
      .prepare(
        `SELECT m.pub machineKey,m.secret,g.device deviceKey,g.expires FROM paired.machine m,paired.grants g
      WHERE m.id=1 AND g.route=? AND g.state='active' AND g.context IS NOT NULL AND g.relayTicket IS NOT NULL AND g.expires>?`,
      )
      .get(pairRoute, this.clock());
    if (!p) reject();
    return p;
  }
  #connection(route) {
    const c = this.#db
      .prepare('SELECT * FROM catalogues WHERE route=? AND revoked=0 AND expires>?')
      .get(route, this.clock());
    if (!c || !['whatsapp','imessage'].includes(c.network) || (c.network==='imessage' && this.#platform!=='darwin')) reject();
    if(c.accountKey !== opaqueBeeperNetworkKey(this.#identity(),c.network,'account',c.accountId)) reject();
    const p = this.#pairing(c.pairRoute);
    if (p.machineKey !== c.machine || p.deviceKey !== c.device || c.expires > p.expires) reject();
    return { c, p };
  }
  #identity() {
    return this.#db.prepare('SELECT key FROM identity WHERE id=1').get().key;
  }
  async approveCatalogue(
    { pairRoute, ownerId, accountId, expiresAt, destination: target, network = 'whatsapp' },
    confirm = confirmBeeperLocally,
  ) {
    const p = this.#pairing(pairRoute);
    if (
      target !== destination ||
      !['whatsapp','imessage'].includes(network) ||
      (network === 'imessage' && this.#platform !== 'darwin') ||
      typeof ownerId !== 'string' ||
      !validId(accountId) ||
      !isHex(pairRoute, 48) ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(ownerId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.clock() ||
      expiresAt > Math.min(p.expires, this.clock() + 86400000)
    )
      reject();
    const accountKey = opaqueBeeperNetworkKey(this.#identity(), network, 'account', accountId);
    const consent = {
      authority: 'beeper.catalogue.read',
      ownerId,
      accountId,
      network,
      target,
      deviceKey: p.deviceKey,
      machineKey: p.machineKey,
      expiresAt,
      disclosure: `${network === 'imessage' ? 'iMessage' : 'WhatsApp'} chat titles, types and activity times`,
    };
    if ((await confirm(Object.freeze(consent))) !== true) reject();
    const route = id(),
      catalogueGrantId = id(),
      relayToken = 'ocbr_' + randomBytes(32).toString('base64url');
    return this.#tx(() => {
      const current = this.#pairing(pairRoute);
      if (
        current.deviceKey !== p.deviceKey ||
        current.machineKey !== p.machineKey ||
        expiresAt <= this.clock() ||
        expiresAt > current.expires
      )
        reject();
      this.#db
        .prepare(
          'INSERT INTO catalogues(route,owner,pairRoute,device,machine,accountId,accountKey,grantId,expires,network) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          route,
          ownerId,
          pairRoute,
          p.deviceKey,
          p.machineKey,
          accountId,
          accountKey,
          catalogueGrantId,
          expiresAt,
          network,
        );
      const expiry = new Date(expiresAt).toISOString(), contract = readContract(network);
      const relayBinding = createHmac('sha256', relayToken)
        .update(
          JSON.stringify([
            contract.protocol,
            route,
            ownerId,
            p.machineKey,
            p.deviceKey,
            accountKey,
            catalogueGrantId,
            expiry,
            destination,
            ...(network === 'imessage' ? [network] : []),
          ]),
        )
        .digest('hex');
      return {
        relayToken,
        publicOffer: {
          protocol: contract.protocol,
          ...(network === 'imessage' ? { network } : {}),
          connectionId: route,
          ownerUserId: ownerId,
          accountKey,
          machineKey: p.machineKey,
          deviceKey: p.deviceKey,
          catalogueGrantId,
          expiresAt: expiry,
          destination,
          relayBinding,
          relayTokenHash: sha(relayToken),
        },
      };
    });
  }
  async readCatalogue(route, adapter, publish) {
    const { c } = this.#connection(route);
    const fence = (start) =>
      this.#tx(() => {
        const { c: live } = this.#connection(route);
        if (live.cursor !== c.cursor) reject();
        return start();
      });
    let called = false;
    const page = await adapter.chats(c.accountId, {
      cursor: c.cursor ?? undefined,
      direction: 'before',
      beforeFetch: (start) =>
        fence(() => {
          if (called) reject();
          called = true;
          return start();
        }),
    });
    if (!called) reject();
    if (page.hasMore && (!validId(page.oldestCursor) || c.cursor === page.oldestCursor)) reject();
    const capturedAt = new Date(this.clock()).toISOString();
    const mapping = { identityKey: this.#identity(), accountId: c.accountId, capturedAt, network:c.network };
    const items = page.items
      .filter((v) => String(v.network).toLowerCase() === c.network && v.merge == null)
      .map((v) => catalogueEntry(v, mapping));
    for (let i = 0; i < Math.max(items.length, 1); i += 200) {
      let dispatched = false;
      await publish({ items: items.slice(i, i + 200), complete: false }, (start) =>
        fence(() => {
          if (dispatched) reject();
          dispatched = true;
          return start();
        }),
      );
      if (!dispatched) reject();
    }
    fence(() =>
      this.#db
        .prepare('UPDATE catalogues SET cursor=? WHERE route=?')
        .run(page.hasMore ? page.oldestCursor : null, route),
    );
    return { count: items.length, hasMore: page.hasMore };
  }
  #scope(c, s) {
    return {
      ...readContract(c.network),
      destination,
      ownerId: c.owner,
      pairRoute: c.pairRoute,
      route: c.route,
      grantId: s.id,
      machineKey: c.machine,
      deviceKey: c.device,
      accountKey: c.accountKey,
      chatKey: s.chatKey,
      expiresAt: c.expires,
    };
  }
  async approveChat(route, chatMetadata, confirm = confirmBeeperLocally) {
    if (chatMetadata.merge != null) reject();
    const { c } = this.#connection(route);
    const chat = {
      id: chatMetadata.id,
      accountID: chatMetadata.accountID,
      network: chatMetadata.network,
      title: chatMetadata.title,
      type: chatMetadata.type,
    };
    const entry = catalogueEntry(chat, {
      identityKey: this.#identity(),
      accountId: c.accountId,
      network: c.network,
      capturedAt: new Date(this.clock()).toISOString(),
    });
    const grantId = id(),
      scope = this.#scope(c, { id: grantId, chatKey: entry.chatKey });
    if (
      (await confirm(
        Object.freeze({
          ...scope,
          accountId: c.accountId,
          chatId: chat.id,
          title: entry.title,
          network: entry.network,
          disclosure: 'selected chat messages and participant attribution',
        }),
      )) !== true
    )
      reject();
    return this.#tx(() => {
      const { p } = this.#connection(route);
      this.#db
        .prepare('INSERT INTO selections(id,route,chatKey,chat) VALUES(?,?,?,?)')
        .run(grantId, route, entry.chatKey, JSON.stringify(chat));
      return {
        grantId,
        wire: sealReadEnvelope(
          { ...p, network: c.network },
          'grant',
          { scope, display: { title: entry.title, chatType: entry.chatType, ...(c.network === 'imessage' ? { network: 'imessage' } : {}) } },
          p.secret,
          randomBytes,
        ),
      };
    });
  }
  revoke(grantId) {
    return this.#tx(() => {
      this.#db.prepare('UPDATE catalogues SET revoked=1 WHERE grantId=? OR route=?').run(grantId, grantId);
      this.#db
        .prepare(
          'UPDATE selections SET revoked=1 WHERE id=? OR route IN(SELECT route FROM catalogues WHERE revoked=1)',
        )
        .run(grantId);
      this.#db.exec(
        "UPDATE operations SET phase='revoked' WHERE grantId IN (SELECT id FROM selections WHERE revoked=1); DELETE FROM batches WHERE job IN(SELECT job FROM operations WHERE phase='revoked')",
      );
    });
  }
  prepare(claim) {
    return this.#tx(() => {
      if (
        !claim ||
        typeof claim !== 'object' ||
        Object.keys(claim).some(
          (k) =>
            ![
              'connectionId',
              'id',
              'accountKey',
              'chatKey',
              'epoch',
              'kind',
              'intent',
              'nextSequence',
              'leaseId',
              'leaseUntil',
              'network',
            ].includes(k),
        )
      )
        reject();
      const { c, p } = this.#connection(claim.connectionId),
        v = openReadEnvelope({ ...p, network: c.network }, 'read', claim.intent, p.secret);
      if (
        !validSelection(v) ||
        Object.keys(v).sort().join(',') !== (c.network === 'imessage' ? readFields.split(',').concat('network').sort().join(',') : readFields) ||
        selectionNetwork(v) !== c.network ||
        (claim.network ?? 'whatsapp') !== c.network ||
        v.operation !== 'readSelected' ||
        v.connectionId !== c.route ||
        !isHex(v.jobId, 48) ||
        !isHex(v.requestId, 32) ||
        !Number.isSafeInteger(v.sequence) ||
        v.sequence < 1 ||
        !Number.isSafeInteger(v.epoch) ||
        v.epoch < 1 ||
        !Number.isSafeInteger(v.until) ||
        v.until <= this.clock() ||
        v.until > Math.min(c.expires, this.clock() + 300000) ||
        !['open', 'refresh', 'earlier'].includes(v.kind) ||
        claim.id !== v.jobId ||
        claim.epoch !== v.epoch ||
        claim.kind !== v.kind ||
        claim.accountKey !== c.accountKey ||
        claim.chatKey !== v.chatKey
      )
        reject();
      const s = this.#db
        .prepare('SELECT * FROM selections WHERE id=? AND route=? AND revoked=0')
        .get(v.grantId, c.route);
      if (!s || !sameSelection(this.#scope(c, s), v) || v.expiresAt !== c.expires) reject();
      const hash = sha(canonical(v)),
        ticket = Object.freeze({ grantId: s.id, jobId: v.jobId, requestId: v.requestId });
      const prior = this.#db.prepare('SELECT * FROM operations WHERE job=?').get(v.jobId);
      if (prior) {
        if (['stopped', 'expired', 'revoked'].includes(prior.phase)) reject();
        if (
          prior.hash !== hash ||
          prior.request !== v.requestId ||
          prior.grantId !== s.id ||
          v.sequence !== s.seq ||
          v.epoch !== s.epoch
        )
          reject();
        return ticket;
      }
      if (v.sequence <= s.seq || v.epoch <= s.epoch || (v.kind === 'earlier' && !s.oldest)) reject();
      this.#db
        .prepare(
          "UPDATE operations SET phase='expired' WHERE grantId=? AND until<=? AND phase IN ('reserved','reading','staged')",
        )
        .run(s.id, this.clock());
      this.#db
        .prepare(
          "DELETE FROM batches WHERE job IN(SELECT job FROM operations WHERE grantId=? AND phase='expired')",
        )
        .run(s.id);
      const cursor = v.kind === 'earlier' ? s.oldest : v.kind === 'refresh' ? s.newest : null;
      this.#db
        .prepare(
          "INSERT INTO operations(job,grantId,request,hash,kind,until,phase,cursor,direction) VALUES(?,?,?,?,?,?,'reserved',?,?)",
        )
        .run(
          v.jobId,
          s.id,
          v.requestId,
          hash,
          v.kind,
          v.until,
          cursor,
          v.kind === 'refresh' && cursor ? 'after' : 'before',
        );
      this.#db.prepare('UPDATE selections SET seq=?,epoch=? WHERE id=?').run(v.sequence, v.epoch, s.id);
      return ticket;
    });
  }
  #operation(t) {
    const o = this.#db
      .prepare('SELECT * FROM operations WHERE job=? AND request=? AND grantId=?')
      .get(t.jobId, t.requestId, t.grantId);
    if (!o || o.until <= this.clock() || ['revoked', 'stopped', 'expired'].includes(o.phase)) reject();
    const s = this.#db.prepare('SELECT * FROM selections WHERE id=? AND revoked=0').get(o.grantId);
    if (!s) reject();
    return { ...this.#connection(s.route), s, o };
  }
  async read(t, adapter) {
    const { c, s, o } = this.#tx(() => {
      const job = this.#operation(t);
      if (job.o.phase === 'reserved')
        this.#db.prepare("UPDATE operations SET phase='reading' WHERE job=?").run(t.jobId);
      else if (!['staged', 'done'].includes(job.o.phase)) reject();
      return job;
    });
    if (o.phase !== 'reserved') return;
    let called = false;
    const chat = JSON.parse(s.chat);
    const page = await adapter.messages(c.accountId, chat.id, {
      cursor: o.cursor ?? undefined,
      direction: o.direction,
      beforeFetch: (start) =>
        this.#tx(() => {
          if (this.#operation(t).o.phase !== 'reading' || called) reject();
          called = true;
          return start();
        }),
    });
    if (!called) reject();
    const payloads = chunks(chat, page, {
      identityKey: this.#identity(),
      accountId: c.accountId,
      network: c.network,
      capturedAt: new Date(this.clock()).toISOString(),
    });
    return this.#tx(() => {
      if (this.#operation(t).o.phase !== 'reading') reject();
      payloads.forEach((payload, sequence) => {
        const final = sequence === payloads.length - 1;
        this.#db
          .prepare('INSERT INTO batches(job,sequence,payload,digest,final) VALUES(?,?,?,?,?)')
          .run(t.jobId, sequence, JSON.stringify(payload), digest(payload, final), Number(final));
      });
      this.#db
        .prepare("UPDATE operations SET phase='staged',oldest=?,newest=? WHERE job=?")
        .run(page.oldestCursor ?? null, page.newestCursor ?? null, t.jobId);
    });
  }
  nextPending(t) {
    const { o } = this.#operation(t);
    if (o.phase === 'done') return null;
    if (o.phase !== 'staged') reject();
    const r = this.#db
      .prepare(
        'SELECT sequence,payload,digest,final FROM batches WHERE job=? AND confirmed=0 ORDER BY sequence LIMIT 1',
      )
      .get(t.jobId);
    if (!r) reject();
    const payload = JSON.parse(r.payload),
      final = Boolean(r.final);
    if (digest(payload, final) !== r.digest) reject();
    return { sequence: r.sequence, payload, digest: r.digest, final };
  }
  beforeDisclosure(t, sequence, start) {
    this.#tx(() => {
      const batch = this.nextPending(t);
      if (!batch || batch.sequence !== sequence) reject();
      this.#db.prepare('UPDATE batches SET attempted=1 WHERE job=? AND sequence=?').run(t.jobId, sequence);
    });
    return this.#tx(() => {
      const batch = this.nextPending(t);
      if (!batch || batch.sequence !== sequence) reject();
      return start(Object.freeze(batch));
    });
  }
  /** Stop this exact authenticated request without reusing its sequence or GET.
   * A fresh explicit native intent may then proceed; old ciphertext remains spent. */
  abandon(t) {
    return this.#tx(() => {
      const o=this.#db.prepare('SELECT phase FROM operations WHERE job=? AND request=? AND grantId=?').get(t.jobId,t.requestId,t.grantId);
      if(!o)reject();if(['done','revoked'].includes(o.phase))return;
      this.#db.prepare("UPDATE operations SET phase='stopped' WHERE job=?").run(t.jobId);
      this.#db.prepare('UPDATE batches SET payload=NULL WHERE job=?').run(t.jobId);
    });
  }
  acknowledge(t, ack) {
    if (
      !validId(ack.chatId) ||
      !Number.isSafeInteger(ack.sequence) ||
      ack.sequence < 0 ||
      !isHex(ack.digest, 64)
    )
      reject();
    return this.#tx(() => {
      const { o } = this.#operation(t),
        r = this.#db
          .prepare('SELECT digest,confirmed,attempted FROM batches WHERE job=? AND sequence=?')
          .get(t.jobId, ack.sequence);
      if (!r || !r.attempted || r.digest !== ack.digest || (o.chatId !== null && o.chatId !== ack.chatId))
        reject();
      if (r.confirmed) return;
      const current = this.nextPending(t);
      if (current?.sequence !== ack.sequence) reject();
      this.#db
        .prepare('UPDATE batches SET confirmed=1,payload=NULL WHERE job=? AND sequence=?')
        .run(t.jobId, ack.sequence);
      this.#db
        .prepare('UPDATE operations SET chatId=?,phase=? WHERE job=?')
        .run(ack.chatId, current.final ? 'done' : 'staged', t.jobId);
      if (current.final) {
        if (o.kind !== 'refresh' || !o.cursor)
          this.#db
            .prepare('UPDATE selections SET oldest=coalesce(?,oldest) WHERE id=?')
            .run(o.oldest, t.grantId);
        if (o.kind !== 'earlier')
          this.#db
            .prepare('UPDATE selections SET newest=coalesce(?,newest) WHERE id=?')
            .run(o.newest, t.grantId);
      }
    });
  }
}
