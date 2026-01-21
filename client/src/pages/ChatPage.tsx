import { useEffect } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ChatSidebar } from '../components/ChatSidebar';
import { MessageList } from '../components/MessageList';
import { MessageInput } from '../components/MessageInput';

export function ChatPage() {
  const { loadConversations, activeConversationId, conversations, isConnected } = useChat();

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  return (
    <div className="flex h-full bg-gray-50">
      <ChatSidebar />

      {/* Main chat area */}
      <div className="flex-1 flex flex-col">
        {activeConversationId ? (
          <>
            {/* Chat header */}
            <div className="px-4 py-3 border-b border-gray-200 bg-white flex items-center justify-between">
              <div>
                <h2 className="font-semibold">
                  {activeConversation?.title || 'Chat'}
                </h2>
                {activeConversation?.participants && activeConversation.participants.length > 0 && (
                  <p className="text-sm text-gray-500">
                    {activeConversation.participants.map(p => p.user.name || p.user.email).join(', ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <span className="text-xs text-green-600 flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    Connected
                  </span>
                ) : (
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-gray-400"></span>
                    Connecting...
                  </span>
                )}
              </div>
            </div>

            <MessageList />
            <MessageInput />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <h2 className="text-xl font-medium mb-2">Welcome to OpenChat</h2>
              <p>Select a conversation or start a new one</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
