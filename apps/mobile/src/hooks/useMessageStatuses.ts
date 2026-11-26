import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MessageStatusEntry } from '../api/client';
import { getSocket } from '../api/socket';

export type MessageStatusMap = Record<string, MessageStatusEntry[]>;

/** Fold one participant's status into the per-message list (one entry per person). */
export function applyMessageStatus(map: MessageStatusMap, entry: MessageStatusEntry): MessageStatusMap {
  const others = (map[entry.messageId] ?? []).filter(item => item.userId !== entry.userId);
  const next = entry.status === 'none' ? others : [...others, entry];
  const result = { ...map };
  if (next.length) result[entry.messageId] = next; else delete result[entry.messageId];
  return result;
}

export function groupMessageStatuses(entries: MessageStatusEntry[]): MessageStatusMap {
  return entries.reduce<MessageStatusMap>((map, entry) => applyMessageStatus(map, entry), {});
}

/**
 * Statuses this viewer may see in one chat: shared statuses from everyone plus
 * the viewer's own private ones. Live updates arrive per participant; a private
 * change from the viewer arrives through `refresh()` after their own save.
 */
// `ready`: requests fail until the account identity is verified, so wait for it rather than failing silently once.
export function useMessageStatuses(conversationId: string | undefined, viewerId: string | undefined, ready = true) {
  const [statuses, setStatuses] = useState<MessageStatusMap>({});
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!conversationId || !ready) return;
    const current = ++generation.current;
    try {
      const value = await api.getConversationMessageStatuses(conversationId);
      if (current === generation.current) setStatuses(groupMessageStatuses(value.statuses));
    } catch { /* Chips are secondary; the sheet reports its own errors. */ }
  }, [conversationId, ready]);

  useEffect(() => { setStatuses({}); void refresh(); }, [refresh]);

  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    const onChanged = (payload: Partial<MessageStatusEntry> & { conversationId?: string }) => {
      if (payload?.conversationId !== conversationId || !payload.messageId || !payload.userId) return;
      // Our own change may be private; re-read so we never guess its visibility.
      if (payload.userId === viewerId) { void refresh(); return; }
      generation.current++;
      setStatuses(map => applyMessageStatus(map, {
        messageId: payload.messageId!, userId: payload.userId!, userName: payload.userName || 'Member',
        status: payload.status === 'open' || payload.status === 'closed' ? payload.status : 'none',
        visibility: 'chat', own: false,
      }));
    };
    // Live events can be missed while disconnected (including after the app was backgrounded): re-read on reconnect.
    const resync = () => { void refresh(); };
    socket?.on('message-status:changed', onChanged);
    socket?.on('connect', resync);
    return () => { socket?.off('message-status:changed', onChanged); socket?.off('connect', resync); };
  }, [conversationId, viewerId, refresh]);

  return { statuses, refresh };
}
