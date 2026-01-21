import { useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ConversationList } from './ConversationList';
import { PresenceIndicator } from './PresenceIndicator';
import { User } from '../api';

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

export function ChatSidebar() {
  const { searchContacts, createConversation, setActiveConversation, presence, currentUser } = useChat();
  const [showContacts, setShowContacts] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Debounce search term (300ms)
  const debouncedSearch = useDebounce(searchTerm, 300);

  // Perform search when debounced term changes
  useEffect(() => {
    if (!showContacts) return;

    const performSearch = async () => {
      // Only search if there's at least 1 character
      if (debouncedSearch.length === 0) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const results = await searchContacts(debouncedSearch);
        setSearchResults(results);
      } finally {
        setIsSearching(false);
      }
    };

    performSearch();
  }, [debouncedSearch, showContacts, searchContacts]);

  const handleNewChat = () => {
    setShowContacts(true);
    setSearchTerm('');
    setSearchResults([]);
    // Focus search input after render
    setTimeout(() => searchInputRef.current?.focus(), 100);
  };

  const handleSelectContact = async (contactId: string) => {
    const conv = await createConversation([contactId]);
    setActiveConversation(conv.id);
    setShowContacts(false);
    setSearchTerm('');
    setSearchResults([]);
  };

  const handleCloseContacts = () => {
    setShowContacts(false);
    setSearchTerm('');
    setSearchResults([]);
  };

  return (
    <div className="w-80 border-r border-gray-200 flex flex-col bg-white">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-semibold">Chats</h1>
          <button
            onClick={handleNewChat}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded-full hover:bg-blue-600"
          >
            New
          </button>
        </div>

        {/* Current user status */}
        {currentUser && (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <PresenceIndicator status="available" size="sm" />
            <span>{currentUser.email}</span>
          </div>
        )}
      </div>

      {/* Contact picker modal/dropdown */}
      {showContacts ? (
        <div className="flex-1 flex flex-col">
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={handleCloseContacts}
                className="text-gray-500 hover:text-gray-700"
              >
                ← Back
              </button>
              <span className="font-medium">Find Contact</span>
            </div>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {searchTerm.length === 0 ? (
              <div className="p-4 text-center text-gray-500">
                <p>Type to search for contacts</p>
                <p className="text-sm mt-1">Search by name or email address</p>
              </div>
            ) : isSearching ? (
              <div className="p-4 text-center text-gray-500">
                <div className="animate-pulse">Searching...</div>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-4 text-center text-gray-500">
                No contacts found for "{searchTerm}"
              </div>
            ) : (
              searchResults.map((contact) => {
                const contactPresence = presence.get(contact.id);

                return (
                  <div
                    key={contact.id}
                    onClick={() => handleSelectContact(contact.id)}
                    className="p-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100"
                  >
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 font-medium">
                          {(contact.name || contact.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5">
                          <PresenceIndicator
                            status={contactPresence?.status || contact.presenceStatus}
                            size="sm"
                          />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{contact.name || contact.email}</div>
                        <div className="text-sm text-gray-500 truncate">{contact.email}</div>
                        {contactPresence?.statusMessage && (
                          <div className="text-xs text-gray-400 truncate">
                            {contactPresence.statusMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <ConversationList />
      )}
    </div>
  );
}
