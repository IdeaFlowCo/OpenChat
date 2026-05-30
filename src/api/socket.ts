/**
 * Socket.io connection to OpenChat. WebSocket transport only (matches the
 * web client's choice — Cloudflare's proxy breaks the polling fallback,
 * causing the reconnect-loop bug fixed in commit 6f229af on the web side).
 */

import { io, Socket } from 'socket.io-client';
import { OPENCHAT_URL, getToken, Message } from './client';

export type SocketEvents = {
  'message:new': (message: Message) => void;
  'typing:start': (data: { conversationId: string; userId: string }) => void;
  'typing:stop': (data: { conversationId: string; userId: string }) => void;
  'presence:updated': (data: { userId: string; status: string; statusMessage?: string }) => void;
  'conversation:created': (data: { conversationId: string; conversation: unknown }) => void;
};

let socket: Socket | null = null;

export async function connect(): Promise<Socket> {
  if (socket && socket.connected) return socket;
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  if (socket) {
    socket.disconnect();
  }
  socket = io(OPENCHAT_URL, {
    auth: { token },
    transports: ['websocket'],
    autoConnect: true,
  });
  return socket;
}

export function disconnect(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function joinConversation(conversationId: string): void {
  socket?.emit('conversation:join', conversationId);
}

export function leaveConversation(conversationId: string): void {
  socket?.emit('conversation:leave', conversationId);
}

export function sendMessage(conversationId: string, content: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Not connected'));
      return;
    }
    socket.emit(
      'message:send',
      { conversationId, content },
      (response: { success?: boolean; message?: Message; error?: string }) => {
        if (response?.error) reject(new Error(response.error));
        else if (response?.message) resolve(response.message);
        else reject(new Error('No response from server'));
      }
    );
  });
}

export function getSocket(): Socket | null {
  return socket;
}
