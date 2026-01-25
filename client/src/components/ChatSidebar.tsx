import { useState, useEffect, useRef, useMemo } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ConversationList } from './ConversationList';
import { PresenceIndicator } from './PresenceIndicator';
import { User } from '../api';

// Environment detection for context-aware UI
type AppEnvironment = 'tailscale' | 'localhost' | 'production';

function detectEnvironment(): AppEnvironment {
  const hostname = window.location.hostname;
  if (/^100\.\d+\.\d+\.\d+$/.test(hostname) || hostname.endsWith('.ts.net')) {
    return 'tailscale';
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'localhost';
  }
  return 'production';
}

// Local dev ports for each service
const LOCAL_PORTS = {
  noos: 33217,
  thoughtstreams: 15737,
  openchat: 41851,
  notes: 3008,
};

function getServiceUrls(env: AppEnvironment) {
  if (env === 'production') {
    return {
      noos: 'https://globalbr.ai',
      thoughtstreams: 'https://ts.globalbr.ai',
      openchat: 'https://chat.globalbr.ai',
      notes: 'https://notes.globalbr.ai',
    };
  }
  const baseHost = env === 'tailscale' ? window.location.hostname : 'localhost';
  return {
    noos: `http://${baseHost}:${LOCAL_PORTS.noos}`,
    thoughtstreams: `http://${baseHost}:${LOCAL_PORTS.thoughtstreams}`,
    openchat: `http://${baseHost}:${LOCAL_PORTS.openchat}`,
    notes: `http://${baseHost}:${LOCAL_PORTS.notes}`,
  };
}

// Generate user initials
function getInitials(user: { name?: string; email: string }): string {
  const name = user.name || user.email.split('@')[0] || '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

// App version (sync with package.json)
const APP_VERSION = '0.1.0';

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
  const { searchContacts, createConversation, setActiveConversation, presence, currentUser, isConnected, updatePresence, logout } = useChat();
  const [showContacts, setShowContacts] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [status, setStatus] = useState<'available' | 'away' | 'busy' | 'invisible'>('available');
  const [statusMessage, setStatusMessage] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const appEnvironment = useMemo(() => detectEnvironment(), []);
  const serviceUrls = useMemo(() => getServiceUrls(appEnvironment), [appEnvironment]);
  const statusMessageTimeoutRef = useRef<number | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close user menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuOpen && userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [userMenuOpen]);
  const presenceInitializedRef = useRef(false);

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

  useEffect(() => {
    if (!isConnected) return;
    if (!presenceInitializedRef.current) {
      return;
    }

    if (statusMessageTimeoutRef.current) {
      window.clearTimeout(statusMessageTimeoutRef.current);
    }

    statusMessageTimeoutRef.current = window.setTimeout(() => {
      updatePresence(status, statusMessage.trim() || undefined);
    }, 800);

    return () => {
      if (statusMessageTimeoutRef.current) {
        window.clearTimeout(statusMessageTimeoutRef.current);
        statusMessageTimeoutRef.current = null;
      }
    };
  }, [statusMessage, status, isConnected, updatePresence]);

  const handleNewChat = () => {
    setShowContacts(true);
    setSearchTerm('');
    setSearchResults([]);
    // Focus search input after render
    setTimeout(() => searchInputRef.current?.focus(), 100);
  };

  const handleStatusChange = (nextStatus: 'available' | 'away' | 'busy' | 'invisible') => {
    presenceInitializedRef.current = true;
    setStatus(nextStatus);
    if (isConnected) {
      updatePresence(nextStatus, statusMessage.trim() || undefined);
    }
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
        <div className="flex items-center justify-between mb-3 gap-2">
          <h1 className="text-xl font-semibold">Chats</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleNewChat}
              className="px-3 py-1 text-sm bg-blue-500 text-white rounded-full hover:bg-blue-600"
            >
              New
            </button>
            {currentUser && (
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium hover:bg-blue-600"
                >
                  {getInitials(currentUser)}
                </button>
                {userMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                    <div className="p-3 border-b border-gray-100">
                      <div className="font-medium text-sm truncate">{currentUser.name || currentUser.email}</div>
                      {(appEnvironment === 'tailscale' || appEnvironment === 'localhost') && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 mt-1 inline-block">
                          {appEnvironment === 'tailscale' ? 'Tailscale' : 'Dev'}
                        </span>
                      )}
                    </div>
                    <div className="py-1">
                      <a
                        href={serviceUrls.notes}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        📓 Notes
                      </a>
                      <a
                        href={serviceUrls.noos}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        🔗 Noos
                      </a>
                      <a
                        href={serviceUrls.thoughtstreams}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        📝 Thoughtstreams
                      </a>
                    </div>
                    <div className="border-t border-gray-100">
                      <button
                        onClick={() => { setUserMenuOpen(false); logout(); }}
                        className="block w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-gray-100"
                      >
                        🚪 Logout
                      </button>
                    </div>
                    <div className="border-t border-gray-100 px-3 py-2 text-center text-xs text-gray-400">
                      v{APP_VERSION}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Current user status */}
        {currentUser && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <PresenceIndicator status={isConnected ? status : 'offline'} size="sm" />
              <span className="truncate">{currentUser.email}</span>
            </div>
            <div className="flex gap-2">
              <select
                value={status}
                onChange={(e) => handleStatusChange(e.target.value as 'available' | 'away' | 'busy' | 'invisible')}
                className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs text-gray-700 bg-white"
                disabled={!isConnected}
              >
                <option value="available">Available</option>
                <option value="away">Away</option>
                <option value="busy">Busy</option>
                <option value="invisible">Invisible</option>
              </select>
              <input
                type="text"
                value={statusMessage}
                onChange={(e) => {
                  presenceInitializedRef.current = true;
                  setStatusMessage(e.target.value);
                }}
                placeholder="Status message"
                className="flex-[2] px-2 py-1 border border-gray-300 rounded text-xs"
                disabled={!isConnected}
              />
            </div>
          </div>
        )}

        {/* Connection warning */}
        {!isConnected && (
          <div className="mt-2 px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded flex items-center gap-1">
            <span className="animate-pulse">●</span>
            Reconnecting...
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
