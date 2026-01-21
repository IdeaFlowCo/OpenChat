import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Message } from '../api';

interface UseChatSocketOptions {
  token: string | null;
  onMessage?: (message: Message) => void;
  onTypingStart?: (data: { conversationId: string; userId: string }) => void;
  onTypingStop?: (data: { conversationId: string; userId: string }) => void;
  onPresenceUpdate?: (data: { userId: string; status: string; statusMessage?: string }) => void;
}

export function useChatSocket(options: UseChatSocketOptions) {
  const { token, onMessage, onTypingStart, onTypingStop, onPresenceUpdate } = options;
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const joinedConversations = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    const socket = io({
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket connected');
      setIsConnected(true);

      // Rejoin conversations on reconnect
      for (const convId of joinedConversations.current) {
        socket.emit('conversation:join', convId);
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      setIsConnected(false);
    });

    socket.on('message:new', (message: Message) => {
      onMessage?.(message);
    });

    socket.on('typing:start', (data) => {
      onTypingStart?.(data);
    });

    socket.on('typing:stop', (data) => {
      onTypingStop?.(data);
    });

    socket.on('presence:updated', (data) => {
      onPresenceUpdate?.(data);
    });

    socket.on('error', (error) => {
      console.error('Socket error:', error);
    });

    // Heartbeat
    const heartbeatInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('heartbeat');
      }
    }, 30000);

    return () => {
      clearInterval(heartbeatInterval);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, onMessage, onTypingStart, onTypingStop, onPresenceUpdate]);

  const joinConversation = useCallback((conversationId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('conversation:join', conversationId);
      joinedConversations.current.add(conversationId);
    }
  }, []);

  const leaveConversation = useCallback((conversationId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('conversation:leave', conversationId);
      joinedConversations.current.delete(conversationId);
    }
  }, []);

  const sendMessage = useCallback((conversationId: string, content: string): Promise<Message> => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current?.connected) {
        reject(new Error('Not connected'));
        return;
      }

      socketRef.current.emit(
        'message:send',
        { conversationId, content },
        (response: { success?: boolean; message?: Message; error?: string }) => {
          if (response.error) {
            reject(new Error(response.error));
          } else if (response.message) {
            resolve(response.message);
          }
        }
      );
    });
  }, []);

  const startTyping = useCallback((conversationId: string) => {
    socketRef.current?.emit('typing:start', conversationId);
  }, []);

  const stopTyping = useCallback((conversationId: string) => {
    socketRef.current?.emit('typing:stop', conversationId);
  }, []);

  const updatePresence = useCallback((status: string, statusMessage?: string) => {
    socketRef.current?.emit('presence:update', { status, statusMessage });
  }, []);

  return {
    isConnected,
    joinConversation,
    leaveConversation,
    sendMessage,
    startTyping,
    stopTyping,
    updatePresence,
  };
}
