// A separate, memory-only point-to-point namespace. No chat joins, history, push or provider hooks.
import { validateToken } from '../middleware/auth.js';
import type { Server, Socket } from 'socket.io';

export function attachMachineRelay(io: Server) {
  const peers = new Map<string, Socket>();
  const perAddress = new Map<string, number>();
  const relay = io.of('/machine-agent-v1');
  relay.use((socket, next) => {
    const { side, token } = socket.handshake.auth ?? {};
    if (side === 'device') {
      const user = typeof token === 'string' && token.length <= 8192 ? validateToken(token) : null;
      if (!user || user.embedded) return next(new Error('Direct OpenChat sign-in required'));
    }
    next();
  });
  relay.on('connection', (socket) => {
    const { route, side } = socket.handshake.auth ?? {};
    const addr = socket.handshake.address;
    const count = perAddress.get(addr) ?? 0;
    if (
      typeof route !== 'string' ||
      !/^[a-f0-9]{48}$/.test(route) ||
      (side !== 'machine' && side !== 'device') ||
      peers.size >= 2000 ||
      count >= 32
    ) {
      socket.disconnect(true);
      return;
    }
    const mine = side + route;
    const other = (side === 'device' ? 'machine' : 'device') + route;
    if (peers.has(mine)) {
      socket.disconnect(true);
      return;
    }
    peers.set(mine, socket);
    perAddress.set(addr, count + 1);
    let start = Date.now(),
      frames = 0;
    socket.on('frame', (frame: unknown, ack: unknown) => {
      if (Date.now() - start > 60_000) {
        start = Date.now();
        frames = 0;
      }
      if (
        ++frames > 60 ||
        typeof frame !== 'string' ||
        frame.length < 56 ||
        frame.length > 48_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(frame)
      ) {
        socket.disconnect(true);
        return;
      }
      const peer = peers.get(other);
      if (peer?.connected) peer.emit('frame', frame);
      if (typeof ack === 'function') ack(Boolean(peer));
    });
    socket.on('disconnect', () => {
      peers.delete(mine);
      const remaining = (perAddress.get(addr) ?? 1) - 1;
      if (remaining) perAddress.set(addr, remaining);
      else perAddress.delete(addr);
    });
  });
}
