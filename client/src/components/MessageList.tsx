import { useEffect, useRef, useState } from 'react';
import { useChat } from '../contexts/ChatContext';
import { TypingBubble } from './TypingBubble';
import { userDisplayName } from '../utils/userDisplay';

// After this many ms without a typing:start heartbeat for a given user,
// we treat them as no longer typing (client-side fallback for dropped
// typing:stop events). MessageInput sends typing:stop after 1.5 s, so
// 3 s is a comfortable safety margin.
const TYPING_AUTO_CLEAR_MS = 3000;

export function MessageList() {
  const { messages, currentUser, typingUsers, activeConversationId, contacts } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Per-user last-seen-typing timestamps for the active conversation.
  // Keyed by userId; updated on every typing:start arrival. We watch
  // the typingUsers map (whose reference changes on every event) and
  // use it to reset per-user timers.
  const [, forceRender] = useState(0);
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const timerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Whenever typingUsers changes, refresh lastSeen timestamps for every
  // currently-typing non-self user in the active conversation, and
  // (re-)arm 3-second auto-clear timers.
  useEffect(() => {
    if (!activeConversationId) return;
    const userIds = typingUsers.get(activeConversationId);
    const now = Date.now();

    if (!userIds || userIds.size === 0) return;

    for (const uid of userIds) {
      if (uid === currentUser?.userId) continue;

      lastSeenRef.current.set(uid, now);

      // Clear existing timer for this user before setting a new one.
      const existing = timerRef.current.get(uid);
      if (existing) clearTimeout(existing);

      const handle = setTimeout(() => {
        lastSeenRef.current.delete(uid);
        timerRef.current.delete(uid);
        forceRender(n => n + 1);
      }, TYPING_AUTO_CLEAR_MS);

      timerRef.current.set(uid, handle);
    }
  }, [typingUsers, activeConversationId, currentUser?.userId]);

  // Clean up all timers when conversation changes or unmounts.
  useEffect(() => {
    return () => {
      for (const handle of timerRef.current.values()) clearTimeout(handle);
      timerRef.current.clear();
      lastSeenRef.current.clear();
    };
  }, [activeConversationId]);

  // Auto-scroll to bottom on new messages or typing change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Build the list of names currently typing (after auto-clear filtering).
  // We cross-reference typingUsers (the live set) with lastSeenRef (which
  // may have entries that haven't yet expired their timer) to get the
  // canonical "is still typing" set.
  const getTypingNames = (): string[] => {
    if (!activeConversationId) return [];
    const userIds = typingUsers.get(activeConversationId);
    if (!userIds || userIds.size === 0) return [];

    return Array.from(userIds)
      .filter(id => {
        if (id === currentUser?.userId) return false;
        // Only show if we have a live lastSeen entry (i.e. timer hasn't fired).
        return lastSeenRef.current.has(id);
      })
      .map(id => {
        const contact = contacts.find(c => c.id === id);
        return contact?.name || contact?.email || 'Someone';
      });
  };

  const typingNames = getTypingNames();

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-y-auto bg-gray-50 dark:bg-slate-950">
        <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-slate-500">
          No messages yet. Start the conversation!
        </div>
        {typingNames.length > 0 && (
          <div className="px-4 pb-2">
            <TypingBubble names={typingNames} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50 dark:bg-slate-950">
      {messages.map((message) => {
        const isOwn = message.senderId === currentUser?.userId;
        const sender = message.sender || (isOwn && currentUser
          ? { id: currentUser.userId, email: currentUser.email, name: currentUser.name || currentUser.email }
          : undefined);

        return (
          <div
            key={message.id}
            className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[70%] px-4 py-2 rounded-2xl ${
                isOwn
                  ? 'bg-blue-500 text-white rounded-br-md'
                  : 'bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-slate-100 rounded-bl-md'
              }`}
            >
              {sender && (
                <div className={`text-xs font-medium mb-1 ${isOwn ? 'text-blue-100' : 'text-gray-500 dark:text-slate-400'}`}>
                  {userDisplayName(sender, currentUser)}
                </div>
              )}
              {/* Image attachments (OpenChat-6bg) */}
              {message.attachments?.map((att, i) => (
                <a
                  key={i}
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mb-1"
                >
                  <img
                    src={att.url}
                    alt="Attachment"
                    className="rounded-lg max-w-full max-h-64 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                    style={att.width && att.height ? { aspectRatio: `${att.width}/${att.height}` } : undefined}
                  />
                </a>
              ))}
              {message.content && <p className="break-words">{message.content}</p>}
              <div
                className={`text-xs mt-1 ${
                  isOwn ? 'text-blue-100' : 'text-gray-400 dark:text-slate-500'
                }`}
              >
                {formatTime(message.createdAt)}
                {message.editedAt && ' (edited)'}
              </div>
            </div>
          </div>
        );
      })}

      {typingNames.length > 0 && (
        <div className="flex justify-start">
          <TypingBubble names={typingNames} />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
