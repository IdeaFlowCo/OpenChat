/**
 * Socket.io connection to OpenChat. WebSocket transport only (matches the
 * web client's choice — Cloudflare's proxy breaks the polling fallback,
 * causing the reconnect-loop bug fixed in commit 6f229af on the web side).
 *
 * This module exports a singleton connection plus tiny send-helpers. The
 * higher-level event handling (message:new, conversation:created, presence,
 * typing) is routed through ChatContext so React state updates happen in
 * one place.
 */

import { io, Socket } from 'socket.io-client';
import { OPENCHAT_URL, getToken, Message, Conversation } from './client';

export interface ParticipantEvent {
  conversationId: string;
  userId: string;
  conversation?: Conversation;
}

export interface ConversationEvent {
  conversationId: string;
  conversation: Conversation;
}

export interface TypingEvent {
  conversationId: string;
  userId: string;
}

export interface PresenceEvent {
  userId: string;
  status: string;
  statusMessage?: string;
}

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
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
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

export function sendMessage(
  conversationId: string,
  content: string,
  replyToId?: string,
  id?: string
): Promise<Message> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Not connected'));
      return;
    }
    const payload: { conversationId: string; content: string; replyToId?: string; id?: string } = {
      conversationId,
      content,
    };
    if (replyToId) payload.replyToId = replyToId;
    // id is a client-generated idempotency key shared with the REST fallback so
    // a lost-ack retry collapses to one row server-side (MERGE). See OpenChat-60y.
    if (id) payload.id = id;
    // 10s ack timeout: on mobile (esp. a China VPN) the socket often reports
    // `connected` but the connection blips right after emit, so the server's
    // ack never arrives. Without a timeout this Promise hangs forever — the
    // caller's REST fallback never runs and the message sits stuck. .timeout()
    // surfaces a lost ack as `err`, we reject, and ChatContext falls back to
    // REST. See OpenChat-5q1.
    socket.timeout(10000).emit(
      'message:send',
      payload,
      (err: Error | null, response: { success?: boolean; message?: Message; error?: string }) => {
        if (err) reject(new Error('Send timed out'));
        else if (response?.error) reject(new Error(response.error));
        else if (response?.message) resolve(response.message);
        else reject(new Error('No response from server'));
      }
    );
  });
}

export function emitTypingStart(conversationId: string): void {
  socket?.emit('typing:start', conversationId);
}

export function emitTypingStop(conversationId: string): void {
  socket?.emit('typing:stop', conversationId);
}

export function emitPresenceUpdate(status: string, statusMessage?: string): void {
  socket?.emit('presence:update', { status, statusMessage });
}

export function getSocket(): Socket | null {
  return socket;
}
