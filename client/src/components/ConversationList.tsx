import { useChat } from '../contexts/ChatContext';
import { PresenceIndicator } from './PresenceIndicator';
import { BotBadge } from './BotBadge';

export function ConversationList() {
  const { conversations, activeConversationId, setActiveConversation, presence, currentUser, unreadByConv } = useChat();

  const getOtherParticipant = (conv: typeof conversations[0]) => {
    const participants = conv.participants || [];
    return participants.find(p => p.user.id !== currentUser?.userId)?.user;
  };

  const getConversationTitle = (conv: typeof conversations[0]) => {
    if (conv.title) return conv.title;
    if (conv.type === 'direct') {
      const other = getOtherParticipant(conv);
      return other?.name || other?.email || 'Unknown';
    }
    return 'Group Chat';
  };

  const formatTime = (dateStr: string | undefined) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return date.toLocaleDateString();
  };

  if (conversations.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500 dark:text-slate-400">
        No conversations yet
      </div>
    );
  }

  return (
    <div className="overflow-y-auto">
      {conversations.map((conv) => {
        const isActive = conv.id === activeConversationId;
        const other = getOtherParticipant(conv);
        const otherPresence = other ? presence.get(other.id) : null;
        const fallbackStatus = other?.presenceStatus;
        const unread = unreadByConv.get(conv.id) ?? 0;
        const hasUnread = unread > 0 && !isActive;

        return (
          <div
            key={conv.id}
            onClick={() => setActiveConversation(conv.id)}
            className={`p-3 cursor-pointer border-b border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800 ${
              isActive ? 'bg-blue-50 dark:bg-blue-900/30' : ''
            }`}
          >
            <div className="flex items-center gap-3">
              {/* Avatar placeholder */}
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-slate-700 flex items-center justify-center text-gray-600 dark:text-slate-300 font-medium">
                  {getConversationTitle(conv).charAt(0).toUpperCase()}
                </div>
                {conv.type === 'direct' && (
                  <div className="absolute -bottom-0.5 -right-0.5">
                    <PresenceIndicator status={otherPresence?.status || fallbackStatus} size="sm" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center">
                  <span className={`truncate flex items-center min-w-0 ${hasUnread ? 'font-semibold text-gray-900 dark:text-slate-50' : 'font-medium text-gray-900 dark:text-slate-100'}`}>
                    <span className="truncate">{getConversationTitle(conv)}</span>
                    {conv.type === 'direct' && other && <BotBadge user={other} compact />}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-slate-500 shrink-0 ml-2 flex items-center gap-2">
                    {formatTime(conv.lastMessageAt)}
                    {hasUnread && (
                      <span
                        className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-semibold bg-blue-500 text-white"
                        aria-label={`${unread} unread`}
                      >
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </span>
                </div>
                {conv.lastMessagePreview && (
                  <p className={`text-sm truncate ${hasUnread ? 'text-gray-700 dark:text-slate-300 font-medium' : 'text-gray-500 dark:text-slate-400'}`}>
                    {conv.lastMessagePreview}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
