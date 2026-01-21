import { useChat } from '../contexts/ChatContext';
import { PresenceIndicator } from './PresenceIndicator';

export function ConversationList() {
  const { conversations, activeConversationId, setActiveConversation, presence, currentUser } = useChat();

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
      <div className="p-4 text-center text-gray-500">
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

        return (
          <div
            key={conv.id}
            onClick={() => setActiveConversation(conv.id)}
            className={`p-3 cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${
              isActive ? 'bg-blue-50' : ''
            }`}
          >
            <div className="flex items-center gap-3">
              {/* Avatar placeholder */}
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 font-medium">
                  {getConversationTitle(conv).charAt(0).toUpperCase()}
                </div>
                {conv.type === 'direct' && (
                  <div className="absolute -bottom-0.5 -right-0.5">
                    <PresenceIndicator status={otherPresence?.status} size="sm" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center">
                  <span className="font-medium truncate">{getConversationTitle(conv)}</span>
                  <span className="text-xs text-gray-400">{formatTime(conv.lastMessageAt)}</span>
                </div>
                {conv.lastMessagePreview && (
                  <p className="text-sm text-gray-500 truncate">{conv.lastMessagePreview}</p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
