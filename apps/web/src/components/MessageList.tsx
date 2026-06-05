import { Fragment, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useChat } from '../contexts/ChatContext';
import { TypingBubble } from './TypingBubble';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MessageContent } from './MessageContent';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { userDisplayName } from '../utils/userDisplay';
import { api, type Message } from '../api';

// Date separator label (bmp.8): "Today", "Yesterday", or a localized date.
function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}
function dateSeparatorLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

// After this many ms without a typing:start heartbeat for a given user,
// we treat them as no longer typing (client-side fallback for dropped
// typing:stop events). MessageInput sends typing:stop after 1.5 s, so
// 3 s is a comfortable safety margin.
const TYPING_AUTO_CLEAR_MS = 3000;

// Quick-reaction emoji row. Mirrors apps/mobile/src/components/ReactionPicker.tsx
// (REACTION_EMOJI) so web + mobile offer the same set. See openchat-bmp.1.
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export function MessageList() {
  const {
    messages,
    currentUser,
    typingUsers,
    activeConversationId,
    contacts,
    conversations,
    editMessage,
    deleteMessage,
    toggleReaction,
    setReplyTo,
    readReceiptsByConv,
    loadOlderMessages,
    hasMoreMessages,
    loadingOlder,
    loadConversations,
    setActiveConversation,
  } = useChat();
  // "Ask my agent" in-flight message id (openchat-ug6).
  const [askingAgentId, setAskingAgentId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Number of messages loaded last render — used to detect prepend (older) vs
  // append (new) so we can preserve scroll position when loading older (bmp.9).
  const prevCountRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);

  // Which message's action menu / reaction picker is open (by id).
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Message currently being edited inline, plus its draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  // Per-user last-seen-typing timestamps for the active conversation.
  const [, forceRender] = useState(0);
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const timerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!activeConversationId) return;
    const userIds = typingUsers.get(activeConversationId);
    const now = Date.now();

    if (!userIds || userIds.size === 0) return;

    for (const uid of userIds) {
      if (uid === currentUser?.userId) continue;

      lastSeenRef.current.set(uid, now);

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

  useEffect(() => {
    return () => {
      for (const handle of timerRef.current.values()) clearTimeout(handle);
      timerRef.current.clear();
      lastSeenRef.current.clear();
    };
  }, [activeConversationId]);

  // Scroll management (bmp.9). Distinguish three cases:
  //   1. Prepend (older page loaded): keep the viewport anchored so the user
  //      doesn't get yanked — restore scrollTop by the height delta.
  //   2. Append (new message / initial load): scroll to bottom.
  //   3. No-op render: do nothing.
  useEffect(() => {
    const el = scrollRef.current;
    const firstId = messages[0]?.id ?? null;
    const prepended =
      messages.length > prevCountRef.current &&
      prevFirstIdRef.current !== null &&
      firstId !== prevFirstIdRef.current &&
      // The previous first message still exists in the list (we added before it).
      messages.some(m => m.id === prevFirstIdRef.current);

    if (prepended && el) {
      // Restore scroll position relative to the new content height.
      const newHeight = el.scrollHeight;
      el.scrollTop = newHeight - prevScrollHeightRef.current;
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevCountRef.current = messages.length;
    prevFirstIdRef.current = firstId;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
  }, [messages]);

  // Infinite-scroll trigger: when the user scrolls near the top and there are
  // older messages, fetch the next page (bmp.9).
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || loadingOlder || !hasMoreMessages) return;
    if (el.scrollTop < 80) {
      prevScrollHeightRef.current = el.scrollHeight;
      void loadOlderMessages();
    }
  };

  // Close any open action menu when switching conversations.
  useEffect(() => {
    setOpenMenuId(null);
    setEditingId(null);
  }, [activeConversationId]);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getTypingNames = (): string[] => {
    if (!activeConversationId) return [];
    const userIds = typingUsers.get(activeConversationId);
    if (!userIds || userIds.size === 0) return [];

    return Array.from(userIds)
      .filter(id => {
        if (id === currentUser?.userId) return false;
        return lastSeenRef.current.has(id);
      })
      .map(id => {
        const contact = contacts.find(c => c.id === id);
        return contact?.name || contact?.email || 'Someone';
      });
  };

  const typingNames = getTypingNames();

  // --- Read receipts (openchat-bmp.4) --------------------------------------
  // For 1:1 conversations, surface a "Read" tick on the sender's OWN most
  // recent message that the other participant has read. We only annotate the
  // latest own read message (iMessage-style) to avoid a wall of ticks.
  const activeConv = conversations.find(c => c.id === activeConversationId);
  // Participant display names used to highlight @mentions (bmp.8).
  const mentionNames = (activeConv?.participants || [])
    .map(p => p.user.name || p.user.email?.split('@')[0] || '')
    .filter(Boolean);
  const isDirect = activeConv?.type === 'direct';
  const otherParticipant = isDirect
    ? activeConv?.participants?.find(p => p.user.id !== currentUser?.userId)?.user
    : undefined;
  const readMap = activeConversationId ? readReceiptsByConv.get(activeConversationId) : undefined;
  const otherLastRead = otherParticipant ? readMap?.[otherParticipant.id] : undefined;

  // Find the id of the latest own message the other party has read.
  let lastReadOwnMessageId: string | null = null;
  if (isDirect && otherLastRead) {
    for (const m of messages) {
      if (m.senderId === currentUser?.userId && !m.deletedAt && m.createdAt <= otherLastRead) {
        lastReadOwnMessageId = m.id;
      }
    }
  }

  const startEdit = (m: Message) => {
    setEditingId(m.id);
    setEditDraft(m.content);
    setOpenMenuId(null);
  };

  const submitEdit = async (m: Message) => {
    const next = editDraft.trim();
    setEditingId(null);
    if (!next || next === m.content) return;
    try {
      await editMessage(m.id, next);
    } catch {
      /* errors surfaced by context */
    }
  };

  const handleDelete = async (m: Message) => {
    setOpenMenuId(null);
    if (!window.confirm('Delete this message?')) return;
    try {
      await deleteMessage(m.id);
    } catch {
      /* errors surfaced by context */
    }
  };

  // "Ask my agent" (openchat-ug6): forward the message to the user's Assistant
  // and navigate to the Assistant DM. The server agent is building
  // /api/assistant/forward in parallel; we code to the agreed contract and it
  // lines up at integration.
  const handleAskAgent = async (m: Message) => {
    if (!activeConversationId || askingAgentId) return;
    setOpenMenuId(null);
    setAskingAgentId(m.id);
    try {
      const { conversationId } = await api.forwardToAssistant({
        sourceConversationId: activeConversationId,
        sourceMessageId: m.id,
      });
      // Make sure the Assistant DM is in the sidebar, then open it.
      await loadConversations();
      setActiveConversation(conversationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not ask your agent.');
    } finally {
      setAskingAgentId(null);
    }
  };

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
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50 dark:bg-slate-950"
    >
      {hasMoreMessages && (
        <div className="flex justify-center pb-1">
          <button
            type="button"
            onClick={() => { if (scrollRef.current) prevScrollHeightRef.current = scrollRef.current.scrollHeight; void loadOlderMessages(); }}
            disabled={loadingOlder}
            className="rounded-full border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        </div>
      )}
      {messages.map((message, mi) => {
        const isOwn = message.senderId === currentUser?.userId;
        const isDeleted = !!message.deletedAt;
        const isEditing = editingId === message.id;
        const menuOpen = openMenuId === message.id;
        // Date separator before the first message of each day (bmp.8).
        const prev = mi > 0 ? messages[mi - 1] : null;
        const showDateSeparator = !prev || dayKey(prev.createdAt) !== dayKey(message.createdAt);
        const sender = message.sender || (isOwn && currentUser
          ? { id: currentUser.userId, email: currentUser.email, name: currentUser.name || currentUser.email }
          : undefined);

        // Resolve a display name for the quoted reply target. ReplyTo.sender
        // carries optional name/email, so resolve defensively rather than via
        // userDisplayName (which requires a full User).
        const replyName = message.replyTo
          ? (message.replyTo.senderId === currentUser?.userId
              ? 'You'
              : message.replyTo.sender?.name
                || message.replyTo.sender?.email
                || message.replyTo.senderName
                || contacts.find(c => c.id === message.replyTo?.senderId)?.name
                || 'Someone')
          : null;

        return (
          <Fragment key={message.id}>
          {showDateSeparator && (
            <div className="flex justify-center py-1">
              <span className="rounded-full bg-gray-200/70 dark:bg-slate-800 px-3 py-0.5 text-[11px] font-medium text-gray-500 dark:text-slate-400">
                {dateSeparatorLabel(message.createdAt)}
              </span>
            </div>
          )}
          <div
            className={`group flex ${isOwn ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`flex flex-col max-w-[75%] ${isOwn ? 'items-end' : 'items-start'}`}>
              <div className="relative flex items-end gap-1">
                {/* Action trigger — left of own bubbles, right of others'. */}
                {!isDeleted && (
                  <button
                    type="button"
                    aria-label="Message actions"
                    onClick={() => setOpenMenuId(menuOpen ? null : message.id)}
                    className={`opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity self-center text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300 ${isOwn ? 'order-first' : 'order-last'}`}
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 11.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 17a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
                    </svg>
                  </button>
                )}

                <div
                  className={`px-4 py-2 rounded-2xl ${
                    isOwn
                      ? 'bg-blue-500 text-white rounded-br-md'
                      : 'bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-slate-100 rounded-bl-md'
                  } ${isDeleted ? 'italic opacity-70' : ''}`}
                >
                  {sender && !isDeleted && (
                    <div className={`text-xs font-medium mb-1 ${isOwn ? 'text-blue-100' : 'text-gray-500 dark:text-slate-400'}`}>
                      {userDisplayName(sender, currentUser)}
                    </div>
                  )}

                  {/* Forwarded provenance (OpenChat-hhc) */}
                  {!isDeleted && message.forwardedFromMessageId && (
                    <div className={`mb-1 text-xs italic ${isOwn ? 'text-blue-100' : 'text-gray-400 dark:text-slate-500'}`}>
                      ↪ Forwarded{message.forwardedFromSenderName ? ` from ${message.forwardedFromSenderName}` : ''}
                    </div>
                  )}

                  {/* Quoted reply preview (openchat-bmp.2) */}
                  {message.replyTo && !isDeleted && (
                    <div
                      className={`mb-1.5 border-l-2 pl-2 py-0.5 text-xs rounded-sm ${
                        isOwn
                          ? 'border-blue-200 bg-blue-400/30 text-blue-50'
                          : 'border-blue-400 bg-black/5 dark:bg-white/5 text-gray-600 dark:text-slate-300'
                      }`}
                    >
                      <div className="font-semibold truncate">{replyName}</div>
                      <div className="truncate opacity-90">
                        {message.replyTo.content || 'Attachment'}
                      </div>
                    </div>
                  )}

                  {/* Attachments: voice (OpenChat-xxc) or image (OpenChat-6bg) */}
                  {!isDeleted && message.attachments?.map((att, i) => {
                    const isAudio = att.type === 'audio' || att.mimeType?.startsWith('audio/');
                    if (isAudio) {
                      // Transcript caption (openchat-4jn): muted/italic text
                      // under the bubble once the server transcribes it. Show
                      // nothing while absent/pending.
                      const transcript = message.transcript?.trim();
                      return (
                        <div key={i}>
                          <VoiceMessageBubble
                            url={att.url}
                            durationMs={att.durationMs ?? 0}
                            messageId={`${message.id}-${i}`}
                            isOwn={isOwn}
                          />
                          {transcript && (
                            <div
                              className={`mt-0.5 text-xs italic ${
                                isOwn ? 'text-blue-100/80' : 'text-gray-500 dark:text-slate-400'
                              }`}
                            >
                              {transcript}
                            </div>
                          )}
                        </div>
                      );
                    }
                    return (
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
                    );
                  })}

                  {isEditing ? (
                    <div className="flex flex-col gap-1">
                      <textarea
                        value={editDraft}
                        autoFocus
                        rows={2}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void submitEdit(message);
                          } else if (e.key === 'Escape') {
                            setEditingId(null);
                          }
                        }}
                        className="w-56 resize-none rounded-lg px-2 py-1 text-sm text-gray-900 bg-white border border-blue-300 focus:outline-none"
                      />
                      <div className="flex gap-2 text-xs">
                        <button type="button" onClick={() => void submitEdit(message)} className="font-medium underline">
                          Save
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} className="opacity-80 underline">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    message.content && <MessageContent content={message.content} isOwn={isOwn} mentionNames={mentionNames} />
                  )}

                  {/* Open Graph link previews (bmp.8) */}
                  {!isDeleted && !isEditing && message.linkPreviews?.map((preview, i) => (
                    <LinkPreviewCard key={`${preview.url}-${i}`} preview={preview} isOwn={isOwn} />
                  ))}

                  <div
                    className={`text-xs mt-1 flex items-center gap-1 ${
                      isOwn ? 'text-blue-100 justify-end' : 'text-gray-400 dark:text-slate-500'
                    }`}
                  >
                    <span>{formatTime(message.createdAt)}</span>
                    {message.editedAt && !isDeleted && <span>(edited)</span>}
                    {isOwn && !isDeleted && message.id === lastReadOwnMessageId && (
                      <span className="ml-0.5" aria-label="Read">✓✓ Read</span>
                    )}
                  </div>
                </div>

                {/* Action menu popover */}
                {menuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setOpenMenuId(null)}
                      aria-hidden="true"
                    />
                    <div
                      className={`absolute z-20 bottom-full mb-1 ${isOwn ? 'right-0' : 'left-0'} w-44 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg dark:shadow-black/40 py-1`}
                    >
                      {/* Quick reactions row */}
                      <div className="flex justify-around px-2 pb-1 mb-1 border-b border-gray-100 dark:border-slate-800">
                        {REACTION_EMOJI.map(emoji => {
                          const mine = message.reactions?.some(r => r.emoji === emoji && r.byMe);
                          return (
                            <button
                              key={emoji}
                              type="button"
                              aria-label={`React with ${emoji}`}
                              onClick={() => {
                                void toggleReaction(message.id, emoji);
                                setOpenMenuId(null);
                              }}
                              className={`text-lg leading-none p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 ${mine ? 'bg-blue-50 dark:bg-blue-900/40' : ''}`}
                            >
                              {emoji}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard?.writeText(message.content ?? '');
                          setOpenMenuId(null);
                        }}
                        className="block w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800"
                      >
                        📋 Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTo(message);
                          setOpenMenuId(null);
                        }}
                        className="block w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800"
                      >
                        ↩ Reply
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAskAgent(message)}
                        disabled={askingAgentId === message.id}
                        className="block w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        🤖 {askingAgentId === message.id ? 'Asking…' : 'Ask my agent'}
                      </button>
                      {isOwn && (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(message)}
                            className="block w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800"
                          >
                            ✏️ Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(message)}
                            className="block w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-slate-800"
                          >
                            🗑 Delete
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Reaction pills (openchat-bmp.1) */}
              {!isDeleted && message.reactions && message.reactions.length > 0 && (
                <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
                  {message.reactions.map(r => (
                    <button
                      key={r.emoji}
                      type="button"
                      onClick={() => void toggleReaction(message.id, r.emoji)}
                      className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${
                        r.byMe
                          ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200'
                          : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700'
                      }`}
                      aria-label={`${r.emoji} ${r.count}${r.byMe ? ' including you' : ''}`}
                    >
                      <span>{r.emoji}</span>
                      <span>{r.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          </Fragment>
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
