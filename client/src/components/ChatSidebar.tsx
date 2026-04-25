import { useState, useEffect, useRef, useMemo } from 'react';
import toast from 'react-hot-toast';
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
const APP_VERSION = '0.2.0';

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

type PickerMode = 'closed' | 'direct' | 'group';

export function ChatSidebar() {
  const { searchContacts, createConversation, setActiveConversation, presence, currentUser, isConnected, updatePresence, logout } = useChat();
  const [pickerMode, setPickerMode] = useState<PickerMode>('closed');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [status, setStatus] = useState<'available' | 'away' | 'busy' | 'invisible'>('available');
  const [statusMessage, setStatusMessage] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Group-creation state
  const [selectedContacts, setSelectedContacts] = useState<User[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const appEnvironment = useMemo(() => detectEnvironment(), []);
  const serviceUrls = useMemo(() => getServiceUrls(appEnvironment), [appEnvironment]);
  const statusMessageTimeoutRef = useRef<number | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const presenceInitializedRef = useRef(false);

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

  // Debounce search term (300ms)
  const debouncedSearch = useDebounce(searchTerm, 300);

  // Perform search when debounced term changes
  useEffect(() => {
    if (pickerMode === 'closed') return;

    const performSearch = async () => {
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
  }, [debouncedSearch, pickerMode, searchContacts]);

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

  const openPicker = (mode: 'direct' | 'group') => {
    setPickerMode(mode);
    setSearchTerm('');
    setSearchResults([]);
    setSelectedContacts([]);
    setGroupTitle('');
    setTimeout(() => searchInputRef.current?.focus(), 100);
  };

  const handleStatusChange = (nextStatus: 'available' | 'away' | 'busy' | 'invisible') => {
    presenceInitializedRef.current = true;
    setStatus(nextStatus);
    if (isConnected) {
      updatePresence(nextStatus, statusMessage.trim() || undefined);
    }
  };

  const handleSelectContact = async (contact: User) => {
    if (pickerMode === 'group') {
      // Toggle in selection
      setSelectedContacts(prev => {
        const exists = prev.some(c => c.id === contact.id);
        if (exists) return prev.filter(c => c.id !== contact.id);
        return [...prev, contact];
      });
      return;
    }

    // Direct: open chat immediately
    try {
      const conv = await createConversation([contact.id]);
      setActiveConversation(conv.id);
      handleClosePicker();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to start chat');
    }
  };

  const handleCreateGroup = async () => {
    if (selectedContacts.length < 2) {
      toast.error('Pick at least 2 people for a group');
      return;
    }
    setCreatingGroup(true);
    try {
      const conv = await createConversation(
        selectedContacts.map(c => c.id),
        groupTitle.trim() || undefined,
        'group'
      );
      setActiveConversation(conv.id);
      handleClosePicker();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create group');
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleClosePicker = () => {
    setPickerMode('closed');
    setSearchTerm('');
    setSearchResults([]);
    setSelectedContacts([]);
    setGroupTitle('');
  };

  const isContactSelected = (id: string) => selectedContacts.some(c => c.id === id);

  return (
    <div className="flex-1 flex flex-col bg-white min-h-0">
      {/* Header */}
      <div className="p-3 md:p-4 border-b border-gray-200 pt-safe">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h1 className="text-xl font-semibold">Chats</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => openPicker('direct')}
              className="px-3 py-2 min-h-[40px] text-sm bg-blue-500 text-white rounded-full hover:bg-blue-600 active:bg-blue-700 font-medium transition-colors"
            >
              + New
            </button>
            <button
              onClick={() => openPicker('group')}
              className="px-3 py-2 min-h-[40px] text-sm bg-white text-blue-600 border border-blue-500 rounded-full hover:bg-blue-50 active:bg-blue-100 font-medium transition-colors"
              title="New group chat"
            >
              + Group
            </button>
            {currentUser && (
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium hover:bg-blue-600 active:bg-blue-700"
                  aria-label="User menu"
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
                        className="block px-3 py-3 text-sm text-gray-700 hover:bg-gray-100 active:bg-gray-200"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        📓 Notes
                      </a>
                      <a
                        href={serviceUrls.noos}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-3 text-sm text-gray-700 hover:bg-gray-100 active:bg-gray-200"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        🔗 Noos
                      </a>
                      <a
                        href={serviceUrls.thoughtstreams}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-3 text-sm text-gray-700 hover:bg-gray-100 active:bg-gray-200"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        📝 Thoughtstreams
                      </a>
                    </div>
                    <div className="border-t border-gray-100">
                      <button
                        onClick={() => { setUserMenuOpen(false); logout(); }}
                        className="block w-full text-left px-3 py-3 text-sm text-red-600 hover:bg-gray-100 active:bg-gray-200"
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
                className="flex-1 px-2 py-2 min-h-[36px] border border-gray-300 rounded text-xs text-gray-700 bg-white"
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
                className="flex-[2] px-2 py-2 min-h-[36px] border border-gray-300 rounded text-xs"
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

      {/* Contact picker */}
      {pickerMode !== 'closed' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={handleClosePicker}
                className="text-gray-500 hover:text-gray-700 active:text-gray-900 px-2 py-1 -ml-2 min-h-[36px]"
              >
                ← Back
              </button>
              <span className="font-medium">
                {pickerMode === 'group' ? 'New Group' : 'Find Contact'}
              </span>
            </div>

            {/* Group title input */}
            {pickerMode === 'group' && (
              <input
                type="text"
                placeholder="Group name (optional)"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                className="w-full px-3 py-2 mb-2 min-h-[40px] border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-base"
              />
            )}

            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 min-h-[40px] border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-base"
              autoFocus
            />

            {/* Selected pills + Create button (group mode) */}
            {pickerMode === 'group' && (
              <>
                {selectedContacts.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selectedContacts.map(c => (
                      <span
                        key={c.id}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs"
                      >
                        {c.name || c.email}
                        <button
                          onClick={() => setSelectedContacts(prev => prev.filter(x => x.id !== c.id))}
                          className="hover:text-blue-900"
                          aria-label={`Remove ${c.name || c.email}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button
                  onClick={handleCreateGroup}
                  disabled={selectedContacts.length < 2 || creatingGroup}
                  className="w-full mt-2 px-4 py-3 min-h-[44px] bg-blue-500 text-white rounded-lg hover:bg-blue-600 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                >
                  {creatingGroup
                    ? 'Creating…'
                    : selectedContacts.length < 2
                      ? `Pick ${2 - selectedContacts.length} more`
                      : `Create group (${selectedContacts.length})`}
                </button>
              </>
            )}
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
                const selected = isContactSelected(contact.id);

                return (
                  <div
                    key={contact.id}
                    onClick={() => handleSelectContact(contact)}
                    className={`p-3 cursor-pointer hover:bg-gray-50 active:bg-gray-100 border-b border-gray-100 min-h-[60px] ${selected ? 'bg-blue-50' : ''}`}
                  >
                    <div className="flex items-center gap-3">
                      {pickerMode === 'group' && (
                        <input
                          type="checkbox"
                          checked={selected}
                          readOnly
                          className="w-5 h-5 accent-blue-500 pointer-events-none"
                          aria-label={`Select ${contact.name || contact.email}`}
                        />
                      )}
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
        <div className="flex-1 overflow-y-auto min-h-0">
          <ConversationList />
        </div>
      )}
    </div>
  );
}
