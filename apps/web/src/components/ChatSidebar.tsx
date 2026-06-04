import { useState, useEffect, useRef, useMemo } from 'react';
import { useChat } from '../contexts/ChatContext';
import { useTheme, ThemePreference } from '../contexts/ThemeContext';
import { ConversationList } from './ConversationList';
import { PresenceIndicator } from './PresenceIndicator';
import { SettingsModal } from './SettingsModal';
import { api, User, SearchResults } from '../api';
import { toastError } from '../utils/toastError';
import { BotBadge } from './BotBadge';
import type { CurrentUserLike } from '../utils/userDisplay';
import {
  currentUserAsContact,
  isSelfSearch,
  isSelfUser,
  rankSelfFirst,
  userDisplayName,
} from '../utils/userDisplay';
import {
  formatVersion,
  readShowVersionInTopBar,
  writeShowVersionInTopBar,
} from '../utils/appVersion';

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
  // Full directory loaded when the picker opens, so users can browse people
  // to DM without having to type first (openchat-2rn). Search narrows it.
  const [allContacts, setAllContacts] = useState<User[]>([]);
  const [loadingAllContacts, setLoadingAllContacts] = useState(false);
  const { preference: themePref, setPreference: setThemePref } = useTheme();
  const [pickerMode, setPickerMode] = useState<PickerMode>('closed');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // Global search: separate state from the contact-picker search so the
  // top-of-sidebar search stays alive when the user opens the picker (and
  // vice versa). Both share the same 300ms debounce — different sources.
  const [globalSearchTerm, setGlobalSearchTerm] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<SearchResults | null>(null);
  const [isGlobalSearching, setIsGlobalSearching] = useState(false);
  const [status, setStatus] = useState<'available' | 'away' | 'busy' | 'invisible'>('available');
  const [statusMessage, setStatusMessage] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showVersionInTopBar, setShowVersionInTopBar] = useState(() => readShowVersionInTopBar());
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
  const debouncedGlobalSearch = useDebounce(globalSearchTerm, 300);

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
        const withSelf = currentUser && isSelfSearch(debouncedSearch) && !results.some(u => u.id === currentUser.userId)
          ? [currentUserAsContact(currentUser), ...results]
          : results;
        setSearchResults(rankSelfFirst(withSelf, currentUser));
      } finally {
        setIsSearching(false);
      }
    };

    performSearch();
  }, [debouncedSearch, pickerMode, searchContacts, currentUser]);

  // Global search effect. Mirrors the contact-picker pattern, but hits the
  // unified /api/chat/search endpoint and renders three sections (messages,
  // conversations, contacts). The server rejects queries shorter than 2
  // characters with an empty bucket — we skip the network round-trip in
  // that case for snappier feedback.
  useEffect(() => {
    let cancelled = false;
    const q = debouncedGlobalSearch.trim();
    if (q.length < 2) {
      setGlobalSearchResults(null);
      setIsGlobalSearching(false);
      return;
    }
    setIsGlobalSearching(true);
    api.search({ q, scope: 'global', limit: 20 })
      .then(results => { if (!cancelled) setGlobalSearchResults(results); })
      .catch(err => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Search failed';
        toastError(msg, { id: 'global-search' });
        setGlobalSearchResults({ messages: [], conversations: [], contacts: [] });
      })
      .finally(() => { if (!cancelled) setIsGlobalSearching(false); });
    return () => { cancelled = true; };
  }, [debouncedGlobalSearch]);

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
    // Browse the full directory (openchat-2rn): fetch all contacts so the
    // empty-search state shows a list instead of "type to search".
    setLoadingAllContacts(true);
    searchContacts('')
      .then(results => setAllContacts(rankSelfFirst(results, currentUser)))
      .catch(() => setAllContacts([]))
      .finally(() => setLoadingAllContacts(false));
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
      toastError(e instanceof Error ? e.message : 'Failed to start chat', { id: 'start-chat' });
    }
  };

  const handleCreateGroup = async () => {
    if (selectedContacts.length < 2) {
      toastError('Pick at least 2 people for a group', { id: 'pick-group-min' });
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
      toastError(e instanceof Error ? e.message : 'Failed to create group', { id: 'create-group' });
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
  const handleShowVersionInTopBarChange = (value: boolean) => {
    setShowVersionInTopBar(value);
    writeShowVersionInTopBar(value);
  };

  // Global search result click handlers. Each one shuts the search panel
  // (clear the input) and routes the user to the right place. We don't
  // try to scroll to the matching message id yet — opening the
  // conversation is enough for v1; per-message highlight is a follow-up.
  const clearGlobalSearch = () => {
    setGlobalSearchTerm('');
    setGlobalSearchResults(null);
  };

  const handleSearchOpenConversation = (conversationId: string) => {
    setActiveConversation(conversationId);
    clearGlobalSearch();
  };

  const handleSearchOpenContact = async (contact: User) => {
    try {
      const conv = await createConversation([contact.id]);
      setActiveConversation(conv.id);
      clearGlobalSearch();
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Failed to start chat', { id: 'start-chat' });
    }
  };

  // Trim+slice helper: keep snippets short and stable for layout.
  const messagePreview = (content: string, q: string): string => {
    const trimmed = content.replace(/\s+/g, ' ').trim();
    if (trimmed.length <= 120) return trimmed;
    // Try to center the snippet on the first match for readability.
    const lower = trimmed.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx < 0) return trimmed.slice(0, 120) + '…';
    const start = Math.max(0, idx - 40);
    const end = Math.min(trimmed.length, start + 120);
    return (start > 0 ? '…' : '') + trimmed.slice(start, end) + (end < trimmed.length ? '…' : '');
  };

  const globalSearchActive = debouncedGlobalSearch.trim().length >= 2;

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-slate-900 min-h-0">
      {/* Header */}
      <div className="p-3 md:p-4 border-b border-gray-200 dark:border-slate-800 pt-safe">
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-slate-100">Chats</h1>
            {showVersionInTopBar && (
              <span className="truncate text-xs font-medium text-gray-400 dark:text-slate-500">{formatVersion()}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => openPicker('direct')}
              className="px-3 py-2 min-h-[40px] text-sm bg-blue-500 text-white rounded-full hover:bg-blue-600 active:bg-blue-700 font-medium transition-colors"
            >
              + New
            </button>
            <button
              onClick={() => openPicker('group')}
              className="px-3 py-2 min-h-[40px] text-sm bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 border border-blue-500 dark:border-blue-400 rounded-full hover:bg-blue-50 dark:hover:bg-slate-800 active:bg-blue-100 dark:active:bg-slate-700 font-medium transition-colors"
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
                  <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg shadow-lg dark:shadow-black/40 z-50">
                    <div className="p-3 border-b border-gray-100 dark:border-slate-800">
                      <div className="font-medium text-sm truncate text-gray-900 dark:text-slate-100">{currentUser.name || currentUser.email}</div>
                      {(appEnvironment === 'tailscale' || appEnvironment === 'localhost') && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300 mt-1 inline-block">
                          {appEnvironment === 'tailscale' ? 'Tailscale' : 'Dev'}
                        </span>
                      )}
                    </div>
                    {/* Theme picker */}
                    <div className="border-b border-gray-100 dark:border-slate-800 px-3 py-2">
                      <div className="text-xs text-gray-500 dark:text-slate-400 mb-1.5">Theme</div>
                      <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Theme">
                        {(['light','system','dark'] as ThemePreference[]).map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            role="radio"
                            aria-checked={themePref === opt}
                            onClick={() => setThemePref(opt)}
                            className={`text-xs py-1.5 rounded capitalize transition-colors ${
                              themePref === opt
                                ? 'bg-blue-500 text-white'
                                : 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-700'
                            }`}
                          >
                            {opt === 'light' ? '☀️' : opt === 'dark' ? '🌙' : '⚙️'} {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="py-1">
                      <button
                        className="block w-full px-3 py-3 text-left text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 active:bg-gray-200 dark:active:bg-slate-700"
                        onClick={() => {
                          setUserMenuOpen(false);
                          setSettingsOpen(true);
                        }}
                      >
                        Settings
                      </button>
                      <a
                        href={serviceUrls.notes}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-3 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 active:bg-gray-200 dark:active:bg-slate-700"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        📓 Notes
                      </a>
                      <a
                        href={serviceUrls.noos}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-3 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 active:bg-gray-200 dark:active:bg-slate-700"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        🔗 Noos
                      </a>
                      <a
                        href={serviceUrls.thoughtstreams}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-3 py-3 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 active:bg-gray-200 dark:active:bg-slate-700"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        📝 Thoughtstreams
                      </a>
                    </div>
                    <div className="border-t border-gray-100 dark:border-slate-800">
                      <button
                        onClick={() => { setUserMenuOpen(false); logout(); }}
                        className="block w-full text-left px-3 py-3 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-slate-800 active:bg-gray-200 dark:active:bg-slate-700"
                      >
                        🚪 Logout
                      </button>
                    </div>
                    <div className="border-t border-gray-100 dark:border-slate-800 px-3 py-2 text-center text-xs text-gray-400 dark:text-slate-500">
                      {formatVersion()}
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
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-400">
              <PresenceIndicator status={isConnected ? status : 'offline'} size="sm" />
              <span className="truncate">{currentUser.email}</span>
            </div>
            <div className="flex gap-2">
              <select
                value={status}
                onChange={(e) => handleStatusChange(e.target.value as 'available' | 'away' | 'busy' | 'invisible')}
                className="flex-1 px-2 py-2 min-h-[36px] border border-gray-300 dark:border-slate-700 rounded text-xs text-gray-700 dark:text-slate-300 bg-white dark:bg-slate-800"
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
                className="flex-[2] px-2 py-2 min-h-[36px] border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded text-xs"
                disabled={!isConnected}
              />
            </div>
          </div>
        )}

        {/* Connection warning */}
        {!isConnected && (
          <div className="mt-2 px-2 py-1 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 text-xs rounded flex items-center gap-1">
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
              <span className="font-medium text-gray-900 dark:text-slate-100">
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
                className="w-full px-3 py-2 mb-2 min-h-[40px] border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded-lg focus:outline-none focus:border-blue-500 text-base"
              />
            )}

            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 min-h-[40px] border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded-lg focus:outline-none focus:border-blue-500 text-base"
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
                        className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-full text-xs"
                      >
                        {userDisplayName(c, currentUser)}
                        <BotBadge user={c} compact />
                        <button
                          onClick={() => setSelectedContacts(prev => prev.filter(x => x.id !== c.id))}
                          className="hover:text-blue-900 dark:hover:text-blue-100"
                          aria-label={`Remove ${userDisplayName(c, currentUser)}`}
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

          <div className="flex-1 overflow-y-auto bg-white dark:bg-slate-900">
            {(() => {
              // When the search box is empty, browse the full directory
              // (openchat-2rn); otherwise show search results.
              const browsing = searchTerm.length === 0;
              const list = browsing ? allContacts : searchResults;
              const loading = browsing ? loadingAllContacts : isSearching;
              if (loading) {
                return (
                  <div className="p-4 text-center text-gray-500 dark:text-slate-400">
                    <div className="animate-pulse">{browsing ? 'Loading contacts…' : 'Searching...'}</div>
                  </div>
                );
              }
              if (list.length === 0) {
                return (
                  <div className="p-4 text-center text-gray-500 dark:text-slate-400">
                    {browsing ? 'No contacts yet' : `No contacts found for "${searchTerm}"`}
                  </div>
                );
              }
              return list.map((contact) => {
                const contactPresence = presence.get(contact.id);
                const selected = isContactSelected(contact.id);

                return (
                  <div
                    key={contact.id}
                    onClick={() => handleSelectContact(contact)}
                    className={`p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 active:bg-gray-100 dark:active:bg-slate-700 border-b border-gray-100 dark:border-slate-800 min-h-[60px] ${selected ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
                  >
                    <div className="flex items-center gap-3">
                      {pickerMode === 'group' && (
                        <input
                          type="checkbox"
                          checked={selected}
                          readOnly
                          className="w-5 h-5 accent-blue-500 pointer-events-none"
                          aria-label={`Select ${userDisplayName(contact, currentUser)}`}
                        />
                      )}
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-slate-700 flex items-center justify-center text-gray-600 dark:text-slate-300 font-medium">
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
                        <div className="font-medium text-gray-900 dark:text-slate-100 flex items-center">
                          <span className="truncate">{userDisplayName(contact, currentUser)}</span>
                          {isSelfUser(contact, currentUser) && (
                            <span className="ml-2 rounded-full bg-blue-50 dark:bg-blue-900/40 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                              self
                            </span>
                          )}
                          <BotBadge user={contact} />
                        </div>
                        <div className="text-sm text-gray-500 dark:text-slate-400 truncate">{contact.email}</div>
                        {contactPresence?.statusMessage && (
                          <div className="text-xs text-gray-400 dark:text-slate-500 truncate">
                            {contactPresence.statusMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      ) : (
        <>
          {/* Global search input — top of sidebar, above the conversation list. */}
          <div className="px-3 md:px-4 pt-3 pb-2 border-b border-gray-200 dark:border-slate-800">
            <div className="relative">
              <input
                type="search"
                value={globalSearchTerm}
                onChange={(e) => setGlobalSearchTerm(e.target.value)}
                placeholder="Search messages, people, groups…"
                className="w-full pl-8 pr-8 py-2 min-h-[36px] border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded-lg focus:outline-none focus:border-blue-500 text-sm"
                aria-label="Search"
              />
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500 pointer-events-none text-sm">
                🔍
              </span>
              {globalSearchTerm && (
                <button
                  type="button"
                  onClick={clearGlobalSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200 text-sm"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {globalSearchActive ? (
              <SearchResultsPanel
                query={debouncedGlobalSearch.trim()}
                results={globalSearchResults}
                isLoading={isGlobalSearching}
                currentUser={currentUser}
                onOpenConversation={handleSearchOpenConversation}
                onOpenContact={handleSearchOpenContact}
                messagePreview={messagePreview}
              />
            ) : (
              <ConversationList />
            )}
          </div>
        </>
      )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        showVersionInTopBar={showVersionInTopBar}
        onShowVersionInTopBarChange={handleShowVersionInTopBarChange}
      />
    </div>
  );
}

// Results panel — rendered when there's an active global search query.
// Three labeled sections; each is omitted when empty (UX cleaner than
// "Conversations: (none)" everywhere). If all three are empty after the
// network round-trip completes, we surface a single "no matches" line.
interface SearchResultsPanelProps {
  query: string;
  results: SearchResults | null;
  isLoading: boolean;
  currentUser: CurrentUserLike | null | undefined;
  onOpenConversation: (conversationId: string) => void;
  onOpenContact: (contact: User) => void;
  messagePreview: (content: string, q: string) => string;
}

function SearchResultsPanel({ query, results, isLoading, currentUser, onOpenConversation, onOpenContact, messagePreview }: SearchResultsPanelProps) {
  // While loading the *first* result for a given query, results === null —
  // show a skeleton. On subsequent re-queries (typing keeps changing the
  // term), we keep the previous results visible so the panel doesn't flash.
  if (!results && isLoading) {
    return (
      <div className="p-4 text-center text-gray-500 dark:text-slate-400">
        <div className="animate-pulse">Searching…</div>
      </div>
    );
  }
  if (!results) {
    return null;
  }

  const { messages, conversations, contacts } = results;
  const empty = messages.length === 0 && conversations.length === 0 && contacts.length === 0;
  if (empty) {
    return (
      <div className="p-4 text-center text-gray-500 dark:text-slate-400">
        No matches for "{query}"
      </div>
    );
  }

  const sectionHeader = (label: string) => (
    <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 bg-gray-50 dark:bg-slate-800/50 sticky top-0">
      {label}
    </div>
  );

  return (
    <div className="bg-white dark:bg-slate-900">
      {conversations.length > 0 && (
        <div>
          {sectionHeader('Conversations')}
          {conversations.map(conv => {
            const title = conv.title?.trim() || (conv.participants || []).map(p => p.name || p.email).join(', ') || 'Untitled';
            const subtitle = (conv.participants || []).map(p => p.name || p.email).join(', ');
            return (
              <div
                key={conv.id}
                onClick={() => onOpenConversation(conv.id)}
                className="p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 active:bg-gray-100 dark:active:bg-slate-700 border-b border-gray-100 dark:border-slate-800"
              >
                <div className="font-medium text-gray-900 dark:text-slate-100 truncate">
                  {title}
                  <span className="ml-2 text-xs text-gray-400 dark:text-slate-500 font-normal">
                    {conv.type === 'group' ? 'group' : 'direct'}
                  </span>
                </div>
                {subtitle && (
                  <div className="text-sm text-gray-500 dark:text-slate-400 truncate">{subtitle}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {messages.length > 0 && (
        <div>
          {sectionHeader('Messages')}
          {messages.map(msg => {
            const convTitle = msg.conversationTitle?.trim() || (msg.conversationType === 'group' ? 'Untitled group' : 'Direct message');
            const senderName = msg.sender?.name || msg.sender?.email || 'Unknown';
            return (
              <div
                key={msg.id}
                onClick={() => onOpenConversation(msg.conversationId)}
                className="p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 active:bg-gray-100 dark:active:bg-slate-700 border-b border-gray-100 dark:border-slate-800"
              >
                <div className="text-xs text-gray-500 dark:text-slate-400 truncate">
                  <span className="font-medium">{senderName}</span>
                  <span className="mx-1">in</span>
                  <span>{convTitle}</span>
                </div>
                <div className="text-sm text-gray-700 dark:text-slate-300 mt-0.5">
                  {messagePreview(msg.content, query)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {contacts.length > 0 && (
        <div>
          {sectionHeader('Contacts')}
          {contacts.map(c => (
            <div
              key={c.id}
              onClick={() => onOpenContact(c)}
              className="p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 active:bg-gray-100 dark:active:bg-slate-700 border-b border-gray-100 dark:border-slate-800"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-slate-700 flex items-center justify-center text-gray-600 dark:text-slate-300 font-medium">
                  {(c.name || c.email).charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 dark:text-slate-100 truncate flex items-center">
                    <span className="truncate">{userDisplayName(c, currentUser)}</span>
                    {isSelfUser(c, currentUser) && (
                      <span className="ml-2 rounded-full bg-blue-50 dark:bg-blue-900/40 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                        self
                      </span>
                    )}
                    <BotBadge user={c} />
                  </div>
                  <div className="text-sm text-gray-500 dark:text-slate-400 truncate">{c.email}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
