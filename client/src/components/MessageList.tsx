import { useEffect, useRef } from 'react';
import { useChat } from '../contexts/ChatContext';

export function MessageList() {
  const { messages, currentUser, typingUsers, activeConversationId, contacts } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getTypingUserNames = () => {
    if (!activeConversationId) return [];
    const userIds = typingUsers.get(activeConversationId);
    if (!userIds || userIds.size === 0) return [];

    return Array.from(userIds)
      .filter(id => id !== currentUser?.userId)
      .map(id => {
        const contact = contacts.find(c => c.id === id);
        return contact?.name || contact?.email || 'Someone';
      });
  };

  const typingNames = getTypingUserNames();

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        No messages yet. Start the conversation!
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((message) => {
        const isOwn = message.senderId === currentUser?.userId;
        const sender = message.sender;

        return (
          <div
            key={message.id}
            className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[70%] px-4 py-2 rounded-2xl ${
                isOwn
                  ? 'bg-blue-500 text-white rounded-br-md'
                  : 'bg-gray-100 text-gray-900 rounded-bl-md'
              }`}
            >
              {!isOwn && sender && (
                <div className="text-xs font-medium text-gray-500 mb-1">
                  {sender.name || sender.email}
                </div>
              )}
              <p className="break-words">{message.content}</p>
              <div
                className={`text-xs mt-1 ${
                  isOwn ? 'text-blue-100' : 'text-gray-400'
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
          <div className="bg-gray-100 text-gray-500 px-4 py-2 rounded-2xl rounded-bl-md text-sm italic">
            {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
