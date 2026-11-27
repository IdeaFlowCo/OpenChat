// Registration requires a direct OpenChat principal. The route commits to its owner, expiry,
// and two independent endpoint credentials. The relay stores only their hashes.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Server, Socket } from 'socket.io';
import { validateToken } from '../middleware/auth.js';
import { securityEvent } from '../services/securityEvent.js';

const proxyAddr = createRequire(import.meta.url)('proxy-addr') as {
  (req: IncomingMessage, trust: (addr: string) => boolean): string;
  compile(ranges: string[]): (addr: string) => boolean;
};
/** Only one concrete, operator-bound nginx peer may supply the nearest forwarded hop.
 * With no pin, record only the transport peer. Addresses never allocate relay capacity.
 */
export function relayAddressReader(configuredPeer = process.env.OPENCHAT_TRUSTED_PROXY) {
  if (configuredPeer && (!isIP(configuredPeer) || configuredPeer.includes('%')))
    throw Error('OPENCHAT_TRUSTED_PROXY must be one literal nginx IP address');
  const matchesPeer = configuredPeer ? proxyAddr.compile([configuredPeer]) : undefined;
  return (req: IncomingMessage): string => {
    const peer = req.socket.remoteAddress;
    if (!peer || !isIP(peer)) return 'unknown';
    if (!matchesPeer?.(peer)) return peer;
    // nginx must overwrite XFF with its verified client, or append its own observed
    // peer on the right. Never walk through a second, client-selected proxy.
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string') return peer;
    const address = forwarded.slice(forwarded.lastIndexOf(',') + 1).trim();
    return isIP(address) && !address.includes('%') ? address : peer;
  };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const day = 24 * 60 * 60_000;
interface Registration {
  owner: string;
  expires: number;
  machineHash: string;
  deviceHash: string;
  seen: number;
  machine?: Socket;
  device?: Socket;
}
export function attachMachineRelay(io: Server, idleMs = 120_000) {
  const readAddress = relayAddressReader();
  let nextDenialLog = 0;
  const routes = new Map<string, Registration>();
  const relay = io.of('/machine-agent-v2');
  function drop(route: string, g: Registration) {
    if (routes.get(route) !== g) return;
    routes.delete(route);
    g.device?.disconnect(true);
    g.machine?.disconnect(true);
  }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [route, g] of routes) if (g.expires <= now || now - g.seen >= idleMs) drop(route, g);
  }, Math.min(15_000, idleMs)).unref();
  io.engine.on('close', () => clearInterval(sweep));

  relay.use((socket, next) => {
    const a = socket.handshake.auth ?? {},
      { route, ticket } = a;
    const side: unknown = a.side;
    const deny = () => {
      const now = Date.now();
      if (now >= nextDenialLog) {
        nextDenialLog = now + 5_000;
        securityEvent('machine_relay_admission', 'denied', { ip: readAddress(socket.request) });
      }
      return next(new Error('Relay admission unavailable'));
    };
    if (
      typeof route !== 'string' ||
      !/^[a-f0-9]{48}$/.test(route) ||
      (side !== 'machine' && side !== 'device') ||
      !key(ticket)
    )
      return deny();
    const now = Date.now(),
      ticketHash = hash(ticket);
    let g = routes.get(route);
    if (g && (g.expires <= now || now - g.seen >= idleMs)) {
      drop(route, g);
      g = undefined;
    }
    if (side === 'device') {
      const user = typeof a.token === 'string' && a.token.length <= 8192 ? validateToken(a.token) : null;
      if (
        !process.env.JWT_SECRET ||
        !user ||
        'embedded' in user ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(user.userId) ||
        !key(a.machineHash) ||
        !Number.isSafeInteger(a.expires) ||
        a.expires <= now ||
        a.expires > now + day ||
        hash(JSON.stringify(['openchat.relay.v2', user.userId, a.expires, a.machineHash, ticketHash])).slice(
          0,
          48,
        ) !== route
      )
        return deny();
      if (!g) {
        if (routes.size >= 2000) return deny();
        let fromUser = 0;
        for (const row of routes.values()) if (row.owner === user.userId) fromUser++;
        if (fromUser >= 8) return deny();
        g = {
          owner: user.userId,
          expires: a.expires,
          machineHash: a.machineHash,
          deviceHash: ticketHash,
          seen: now,
        };
        routes.set(route, g);
      }
      if (g.owner !== user.userId || g.deviceHash !== ticketHash) return deny();
      socket.data.relayUntil = Math.min(
        g.expires,
        typeof user.exp === 'number' ? user.exp * 1000 : g.expires,
      );
    } else if (!g || g.machineHash !== ticketHash) return deny();
    if (!g || g[side]) return deny();
    g[side] = socket;
    const expiry = setTimeout(
      () => socket.disconnect(true),
      (socket.data.relayUntil ?? g.expires) - now,
    ).unref();
    const registration = g;
    const cleanup = () => {
      clearTimeout(expiry);
      if (registration[side] === socket) delete registration[side];
    };
    socket.conn.once('close', cleanup);
    socket.once('disconnect', cleanup);
    socket.data.registration = g;
    next();
  });
  relay.on('connection', (socket) => {
    const { side, route } = socket.handshake.auth;
    const g: Registration = socket.data.registration;
    const peer = () => (side === 'device' ? g.machine : g.device);
    if (peer()?.connected) {
      socket.emit('ready');
      peer()?.emit('ready');
    }
    let start = Date.now(),
      count = 0;
    socket.on('frame', (frame: unknown, ack: unknown) => {
      const now = Date.now();
      if (socket.data.relayUntil && now >= socket.data.relayUntil) {
        socket.disconnect(true);
        return;
      }
      if (now >= g.expires || now - g.seen >= idleMs) {
        drop(route, g);
        return;
      }
      if (now - start >= 60_000) {
        start = now;
        count = 0;
      }
      if (
        ++count > 60 ||
        typeof frame !== 'string' ||
        frame.length < 56 ||
        frame.length > 48_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(frame)
      ) {
        socket.disconnect(true);
        return;
      }
      g.seen = now;
      const other = peer();
      if (other?.data.relayUntil && now >= other.data.relayUntil) other.disconnect(true);
      if (other?.connected) other.emit('frame', frame);
      if (typeof ack === 'function') ack(!!other?.connected);
    });
  });
}
