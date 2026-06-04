import { useEffect, useState } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ChatSidebar } from '../components/ChatSidebar';
import { MessageList } from '../components/MessageList';
import { MessageInput } from '../components/MessageInput';
import { GroupSettings } from '../components/GroupSettings';
import { BotBadge } from '../components/BotBadge';
import { userDisplayName } from '../utils/userDisplay';

export function ChatPage() {
  const { loadConversations, activeConversationId, setActiveConversation, conversations, isConnected, currentUser } = useChat();
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Toggle a data-attribute on <html> while a conversation is active so the
  // Noos feedback widget can be hidden on mobile (where it floats into the
  // chat area when the keyboard is open). The widget mounts as
  // <div id="noos-feedback-widget"> outside the React tree; CSS in index.css
  // targets it via this attribute. Per codex review 2026-05-30.
  useEffect(() => {
    const el = document.documentElement;
    if (activeConversationId) {
      el.setAttribute('data-active-conversation', '');
    } else {
      el.removeAttribute('data-active-conversation');
    }
    return () => {
      el.removeAttribute('data-active-conversation');
    };
  }, [activeConversationId]);

  const activeConversation = conversations.find(c => c.id === activeConversationId);
  const isGroup = activeConversation?.type === 'group';
  const directParticipant = activeConversation?.type === 'direct'
    ? activeConversation.participants?.find(p => p.user.id !== currentUser?.userId)?.user
      || activeConversation.participants?.find(p => p.user.id === currentUser?.userId)?.user
    : null;

  // On mobile, the layout is a stack: list OR chat. On md+, side-by-side.
  // hasActive controls which pane is visible on small screens.
  const hasActive = !!activeConversationId;

  return (
    <div className="flex h-full bg-gray-50 dark:bg-slate-950 pl-safe pr-safe">
      {/* Sidebar — full-width on mobile when no conv active; fixed w-80 on md+ */}
      <aside
        className={`${hasActive ? 'hidden md:flex' : 'flex'} flex-1 md:flex-none md:w-80 border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col`}
      >
        <ChatSidebar />
      </aside>

      {/* Main chat area — hidden on mobile when no conv selected */}
      <main className={`${hasActive ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {activeConversationId && activeConversation ? (
          <>
            {/* Chat header */}
            <div className="px-3 py-2 md:px-4 md:py-3 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-2 pt-safe">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {/* Back button — only on mobile */}
                <button
                  onClick={() => setActiveConversation(null)}
                  className="md:hidden p-2 -ml-2 text-gray-600 dark:text-slate-300 hover:text-gray-900 dark:hover:text-slate-100 active:bg-gray-100 dark:active:bg-slate-800 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center"
                  aria-label="Back to conversations"
                >
                  {/* Chevron-left */}
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => isGroup && setGroupSettingsOpen(true)}
                  disabled={!isGroup}
                  className={`flex-1 min-w-0 text-left ${isGroup ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 -mx-2 px-2 py-1 rounded' : 'cursor-default'}`}
                >
                  <h2 className="font-semibold truncate text-gray-900 dark:text-slate-100 flex items-center min-w-0">
                    <span className="truncate">
                      {activeConversation.title ||
                        (activeConversation.type === 'direct'
                          ? directParticipant
                            ? userDisplayName(directParticipant, currentUser)
                            : 'Chat'
                          : 'Group Chat')}
                    </span>
                    {activeConversation.type === 'direct' && (
                      <BotBadge
                        user={directParticipant}
                      />
                    )}
                    {activeConversation.type === 'group'
                      && activeConversation.participants?.some(p => p.user.isBot) && (
                      <BotBadge user={{ isBot: true }} compact />
                    )}
                  </h2>
                  {activeConversation.participants && activeConversation.participants.length > 0 && (
                    <p className="text-xs md:text-sm text-gray-500 dark:text-slate-400 truncate">
                      {isGroup
                        ? `${activeConversation.participants.length} members`
                        : activeConversation.participants
                            .map(p => userDisplayName(p.user, currentUser))
                            .join(', ')}
                    </p>
                  )}
                </button>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isConnected ? (
                  <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1" aria-label="Connected">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    <span className="hidden sm:inline">Connected</span>
                  </span>
                ) : (
                  <span className="text-xs text-gray-400 dark:text-slate-500 flex items-center gap-1" aria-label="Connecting">
                    <span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-slate-600 animate-pulse"></span>
                    <span className="hidden sm:inline">Connecting...</span>
                  </span>
                )}
              </div>
            </div>

            <MessageList />
            <MessageInput />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-slate-500 p-6">
            <div className="text-center">
              <h2 className="text-xl font-medium mb-2 text-gray-700 dark:text-slate-300">Welcome to OpenChat</h2>
              <p>Select a conversation or start a new one</p>
            </div>
          </div>
        )}
      </main>

      {/* Group settings modal */}
      {activeConversation && isGroup && (
        <GroupSettings
          open={groupSettingsOpen}
          onClose={() => setGroupSettingsOpen(false)}
          conversation={activeConversation}
        />
      )}
    </div>
  );
}
