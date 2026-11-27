import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { catalogueEntry, opaqueBeeperKey } from './desktopApi.mjs';
import { isHex } from '../../apps/mobile/src/services/beeper/readProtocol.mjs';
import {
  protocol,
  audience,
  destination,
  deny,
  ownerId,
  exact,
  validText,
  validDisplay,
  publicTuple,
  pinBody,
  writeBox,
  openWriteBox,
} from '../../apps/mobile/src/services/beeper/writeProtocol.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const id = () => randomBytes(24).toString('hex');
const safe = (v) =>
  typeof v === 'string' &&
  v.trim() &&
  v.length <= 2000 &&
  !['.', '..'].includes(v) &&
  !/[\u0000-\u001f\u007f]/.test(v);
const scopeDigest = (s) =>
  sha(
    JSON.stringify(
      Object.keys(s)
        .sort()
        .map((k) => [k, s[k]]),
    ),
  );
function privatePath(path, dir) {
  const s = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    s.uid !== process.getuid() ||
    s.mode & 0o077 ||
    (dir ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
  )
    deny();
}
export class BeeperWriteAuthority {
  #db;
  #clock;
  #dir;
  constructor({ directory, pairingDirectory, clock = Date.now }) {
    privatePath(pairingDirectory, true);
    const paired = join(pairingDirectory, 'authority.db');
    privatePath(paired, false);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    const file = join(directory, 'beeper-write.db');
    if (!existsSync(file)) {
      try {
        closeSync(openSync(file, 'wx', 0o600));
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    privatePath(file, false);
    this.#clock = clock;
    this.#dir = directory;
    this.#db = new DatabaseSync(file);
    this.#db.prepare('ATTACH DATABASE ? AS paired').run(paired);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS keys(id INTEGER PRIMARY KEY CHECK(id=1),secret BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS grants(route TEXT PRIMARY KEY,pairRoute TEXT NOT NULL,offer TEXT NOT NULL,display TEXT NOT NULL,account TEXT NOT NULL,chat TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS replies(route TEXT NOT NULL,ref TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(route,ref));
      CREATE TABLE IF NOT EXISTS requests(op TEXT PRIMARY KEY, route TEXT NOT NULL, seq INTEGER NOT NULL, frameHash TEXT NOT NULL,scopeHash TEXT NOT NULL,state TEXT,revision INTEGER NOT NULL DEFAULT 0,UNIQUE(route,seq));
      CREATE TABLE IF NOT EXISTS receipts(op TEXT PRIMARY KEY,revision INTEGER NOT NULL,wire TEXT NOT NULL);`);
    this.#db.prepare('INSERT OR IGNORE INTO keys VALUES(1,?)').run(randomBytes(32));
  }
  close() {
    this.#db.close();
  }
  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.#db.exec('COMMIT');
      return v;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
  #parent(route) {
    const p = this.#db
      .prepare(
        `SELECT m.pub machineKey,m.secret,g.device deviceKey,g.expires,g.relayTicket
      FROM paired.machine m,paired.grants g WHERE m.id=1 AND g.route=? AND g.state='active' AND g.context IS NOT NULL AND g.expires>?`,
      )
      .get(route, this.#clock());
    if (!p || !isHex(p.relayTicket, 64) || !isHex(p.deviceKey, 64) || !isHex(p.machineKey, 64)) deny();
    return p;
  }
  #grant(route) {
    const g = this.#db.prepare('SELECT * FROM grants WHERE route=? AND revoked=0').get(route);
    if (!g) deny();
    const p = this.#parent(g.pairRoute),
      o = JSON.parse(g.offer),
      display = JSON.parse(g.display);
    if (
      p.deviceKey !== o.deviceKey ||
      p.machineKey !== o.machineKey ||
      Date.parse(o.expiresAt) > p.expires ||
      Date.parse(o.expiresAt) <= this.#clock()
    )
      deny();
    return { g, p, o, display };
  }
  #key() {
    return this.#db.prepare('SELECT secret FROM keys WHERE id=1').get().secret;
  }
  async approveWrite(
    { pairRoute, ownerId: owner, accountId, chatMetadata, expiresAt, destination: target },
    confirm,
  ) {
    const p = this.#parent(pairRoute);
    if (
      typeof confirm !== 'function' ||
      !ownerId(owner) ||
      !isHex(pairRoute, 48) ||
      target !== destination ||
      !safe(accountId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.#clock() ||
      expiresAt > Math.min(this.#clock() + 86400000, p.expires)
    )
      deny();
    const sourceChat = chatMetadata.id,
      grant = id(),
      route = id();
    const grantKey = createHmac('sha256', this.#key())
      .update(JSON.stringify([protocol, route, owner, pairRoute]))
      .digest();
    const c = catalogueEntry(chatMetadata, {
      identityKey: grantKey,
      accountId,
      capturedAt: new Date(this.#clock()).toISOString(),
    });
    const display = { title: c.title, chatType: c.chatType, network: c.network };
    if (!validDisplay(display)) deny();
    const token = 'ocbs_' + randomBytes(32).toString('base64url');
    const o = {
      protocol,
      connectionId: route,
      ownerUserId: owner,
      machineKey: p.machineKey,
      deviceKey: p.deviceKey,
      accountKey: c.accountKey,
      chatKey: c.chatKey,
      writeGrantId: grant,
      expiresAt: new Date(expiresAt).toISOString(),
      destination,
      relayTokenHash: sha(token),
    };
    o.relayBinding = createHmac('sha256', token)
      .update(JSON.stringify(publicTuple(o)))
      .digest('hex');
    if (
      (await confirm(
        Object.freeze({
          authority: audience,
          ownerId: owner,
          accountId,
          chatId: sourceChat,
          ...display,
          machineKey: p.machineKey,
          deviceKey: p.deviceKey,
          destination,
          expiresAt,
          permission: 'Send separately approved messages to this exact WhatsApp chat',
        }),
      )) !== true
    )
      deny();
    return this.#tx(() => {
      const current = this.#parent(pairRoute);
      if (
        current.deviceKey !== p.deviceKey ||
        current.machineKey !== p.machineKey ||
        current.expires < expiresAt ||
        this.#clock() >= expiresAt
      )
        deny();
      this.#db
        .prepare('INSERT INTO grants(route,pairRoute,offer,display,account,chat) VALUES(?,?,?,?,?,?)')
        .run(route, pairRoute, JSON.stringify(o), JSON.stringify(display), accountId, sourceChat);
      return {
        publicOffer: o,
        relayToken: token,
        wire: writeBox(p, 'grant', { offer: o, pairRoute, display }, p.secret, randomBytes),
      };
    });
  }
  revoke(route) {
    return this.#tx(
      () => this.#db.prepare('UPDATE grants SET revoked=1 WHERE route=?').run(route).changes === 1,
    );
  }
  // Local adapter metadata only. The device can supply the opaque reference in a
  // signed intent; no incoming frame can populate or redefine this mapping.
  bindReplyTarget(route, message) {
    return this.#tx(() => {
      const { g } = this.#grant(route);
      if (message.accountID !== g.account || message.chatID !== g.chat || !safe(message.id)) deny();
      const ref = opaqueBeeperKey(this.#key(), 'write-reply', route, g.account, g.chat, message.id);
      this.#db.prepare('INSERT OR IGNORE INTO replies VALUES(?,?,?)').run(route, ref, message.id);
      return ref;
    });
  }
  verify(frame) {
    if (
      !exact(frame, ['connectionId', 'operationId', 'opaqueIntent']) ||
      !isHex(frame.operationId, 48) ||
      !isHex(frame.connectionId, 48)
    )
      deny();
    return this.#tx(() => {
      const { g, o, p, display } = this.#grant(frame.connectionId);
      const body = openWriteBox(p, 'intent', frame.opaqueIntent, p.secret);
      if (
        !exact(body, ['pins', 'operationId', 'sequence', 'until', 'text', 'replyTo', 'deviceTicketHash']) ||
        JSON.stringify(body.pins) !== JSON.stringify(pinBody(o, g.pairRoute)) ||
        body.operationId !== frame.operationId ||
        !isHex(body.deviceTicketHash, 64) ||
        !validText(body.text) ||
        !Number.isSafeInteger(body.sequence) ||
        body.sequence < 1 ||
        !Number.isSafeInteger(body.until) ||
        body.until > Date.parse(o.expiresAt) ||
        body.until > this.#clock() + 300000 ||
        (body.replyTo !== null && !isHex(body.replyTo, 64))
      )
        deny();
      const parentRoute = sha(
        JSON.stringify([
          'openchat.relay.v2',
          o.ownerUserId,
          p.expires,
          sha(p.relayTicket),
          body.deviceTicketHash,
        ]),
      ).slice(0, 48);
      if (parentRoute !== g.pairRoute) deny();
      const replyToMessageId =
        body.replyTo === null
          ? null
          : this.#db.prepare('SELECT source FROM replies WHERE route=? AND ref=?').get(g.route, body.replyTo)
              ?.source;
      if (replyToMessageId === undefined) deny();
      const scope = {
        protocol,
        audience,
        ownerId: o.ownerUserId,
        route: g.route,
        machineKey: p.machineKey,
        deviceKey: p.deviceKey,
        accountKey: o.accountKey,
        chatKey: o.chatKey,
        grantId: o.writeGrantId,
        operationId: body.operationId,
        sequence: body.sequence,
        until: body.until,
        text: body.text,
        replyToMessageId,
        accountId: g.account,
        chatId: g.chat,
        title: display.title,
        network: display.network,
      };
      const binding = scopeDigest(scope),
        wireHash = sha(frame.opaqueIntent);
      const prev = this.#db.prepare('SELECT * FROM requests WHERE op=?').get(body.operationId);
      if (prev) {
        if (prev.route !== g.route || prev.scopeHash !== binding || prev.frameHash !== wireHash) deny();
      } else {
        if (body.until <= this.#clock()) deny();
        this.#db
          .prepare('INSERT INTO requests(op,route,seq,frameHash,scopeHash) VALUES(?,?,?,?,?)')
          .run(body.operationId, g.route, body.sequence, wireHash, binding);
      }
      return Object.freeze(scope);
    });
  }
  #fence(scope, start, liveIntent) {
    if (typeof start !== 'function') deny();
    return this.#tx(() => {
      this.#grant(scope.route);
      const r = this.#db
        .prepare('SELECT * FROM requests WHERE op=? AND route=?')
        .get(scope.operationId, scope.route);
      if (!r || r.scopeHash !== scopeDigest(scope) || (liveIntent && scope.until <= this.#clock())) deny();
      if (!liveIntent && !['pending', 'unknown'].includes(this.#kernel(scope.operationId, r).state)) deny();
      // Synchronously initiates the checked adapter action while revocation on
      // either attached ledger is excluded. Await its result after COMMIT.
      return start();
    });
  }
  admit(s, start) {
    return this.#fence(s, start, true);
  }
  admitStatus(s, start) {
    return this.#fence(s, start, false);
  }
  #kernel(op, r) {
    const file = join(this.#dir, 'beeper-send-outbox.db');
    privatePath(file, false);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const s = db.prepare('SELECT scope,state FROM sends WHERE id=?').get(op);
      if (!s || scopeDigest(JSON.parse(s.scope)) !== r.scopeHash) deny();
      return s;
    } finally {
      db.close();
    }
  }
  beforeStatusDisclosure(route, op, receipt, start) {
    if (
      typeof start !== 'function' ||
      !receipt ||
      !Number.isSafeInteger(receipt.revision) ||
      typeof receipt.wire !== 'string'
    )
      deny();
    return this.#tx(() => {
      this.#grant(route);
      const r = this.#db
        .prepare(
          'SELECT r.*,c.wire FROM requests r JOIN receipts c ON c.op=r.op AND c.revision=r.revision WHERE r.route=? AND r.op=?',
        )
        .get(route, op);
      if (
        !r ||
        r.revision !== receipt.revision ||
        r.wire !== receipt.wire ||
        this.#kernel(op, r).state !== r.state
      )
        deny();
      return start();
    });
  }
  sealStatus(route, op, expectedState) {
    return this.statusReceipt(route, op, expectedState).wire;
  }
  statusReceipt(route, op, expectedState) {
    return this.#tx(() => {
      const { g, p, o } = this.#grant(route);
      const r = this.#db.prepare('SELECT * FROM requests WHERE route=? AND op=?').get(route, op);
      if (!r) deny();
      const { state } = this.#kernel(op, r);
      if (
        (expectedState !== undefined && expectedState !== state) ||
        ![
          'review',
          'approved',
          'attempted',
          'unknown',
          'pending',
          'confirmed',
          'failed',
          'cancelled',
        ].includes(state)
      )
        deny();
      const terminal = ['confirmed', 'failed', 'cancelled'].includes(state);
      const cached = this.#db.prepare('SELECT revision,wire FROM receipts WHERE op=?').get(op);
      if (r.state === state && cached?.revision === r.revision)
        return { operationId: op, revision: r.revision, wire: cached.wire, terminal };
      if (r.state !== state && ['confirmed', 'failed', 'cancelled'].includes(r.state)) deny();
      const revision = r.revision + 1;
      const wire = writeBox(
        p,
        'receipt',
        {
          pins: pinBody(o, g.pairRoute),
          operationId: op,
          sequence: r.seq,
          frameHash: r.frameHash,
          state,
          revision,
        },
        p.secret,
        randomBytes,
      );
      this.#db.prepare('UPDATE requests SET state=?,revision=? WHERE op=?').run(state, revision, op);
      this.#db
        .prepare(
          'INSERT INTO receipts VALUES(?,?,?) ON CONFLICT(op) DO UPDATE SET revision=excluded.revision,wire=excluded.wire',
        )
        .run(op, revision, wire);
      return { operationId: op, revision, wire, terminal };
    });
  }
}
