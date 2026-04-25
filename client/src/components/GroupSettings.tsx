import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useChat } from '../contexts/ChatContext';
import { Conversation, User } from '../api';
import { PresenceIndicator } from './PresenceIndicator';

interface GroupSettingsProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
}

// Debounce hook (local copy — small enough to inline)
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function GroupSettings({ open, onClose, conversation }: GroupSettingsProps) {
  const { currentUser, renameConversation, addParticipant, removeParticipant, searchContacts, presence } = useChat();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(conversation.title || '');
  const [savingTitle, setSavingTitle] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const debouncedSearch = useDebounce(search, 300);

  // Reset local state when the conversation changes or modal closes/reopens
  useEffect(() => {
    if (open) {
      setTitleDraft(conversation.title || '');
      setEditingTitle(false);
      setShowAdd(false);
      setSearch('');
      setResults([]);
    }
  }, [open, conversation.id, conversation.title]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Search when adding members
  useEffect(() => {
    if (!showAdd) return;
    if (debouncedSearch.length === 0) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    searchContacts(debouncedSearch)
      .then(found => {
        if (cancelled) return;
        // Filter out users who are already members
        const existing = new Set((conversation.participants || []).map(p => p.user.id));
        setResults(found.filter(u => !existing.has(u.id)));
      })
      .finally(() => !cancelled && setIsSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, showAdd, searchContacts, conversation.participants]);

  if (!open) return null;

  const meParticipant = conversation.participants?.find(p => p.user.id === currentUser?.userId);
  const isOwner = meParticipant?.role === 'owner';

  const handleSaveTitle = async () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === conversation.title) {
      setEditingTitle(false);
      setTitleDraft(conversation.title || '');
      return;
    }
    setSavingTitle(true);
    try {
      await renameConversation(conversation.id, trimmed);
      setEditingTitle(false);
      toast.success('Group renamed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to rename group');
    } finally {
      setSavingTitle(false);
    }
  };

  const handleAdd = async (user: User) => {
    setBusyUserId(user.id);
    try {
      await addParticipant(conversation.id, user.id);
      setSearch('');
      setResults([]);
      toast.success(`Added ${user.name || user.email}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add member');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (userId: string, label: string) => {
    if (!confirm(`Remove ${label} from this group?`)) return;
    setBusyUserId(userId);
    try {
      await removeParticipant(conversation.id, userId);
      toast.success(`Removed ${label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove member');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleLeave = async () => {
    if (!currentUser) return;
    if (!confirm('Leave this group? You will need to be re-added to rejoin.')) return;
    try {
      await removeParticipant(conversation.id, currentUser.userId);
      toast.success('Left group');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to leave group');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-settings-title"
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 p-0 md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl shadow-xl max-h-[90vh] flex flex-col pb-safe"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2">
          <h2 id="group-settings-title" className="font-semibold">Group settings</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 -m-2 text-gray-500 hover:text-gray-900 min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Title */}
          <section>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Name</label>
            {editingTitle ? (
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="flex-1 px-3 py-2 min-h-[40px] border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-base"
                  autoFocus
                />
                <button
                  onClick={handleSaveTitle}
                  disabled={savingTitle}
                  className="px-4 py-2 min-h-[40px] bg-blue-500 text-white rounded-lg hover:bg-blue-600 active:bg-blue-700 disabled:opacity-50 font-medium"
                >
                  Save
                </button>
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-2">
                <span className="flex-1 text-base">{conversation.title || <em className="text-gray-400">Untitled group</em>}</span>
                {isOwner && (
                  <button
                    onClick={() => { setEditingTitle(true); setTitleDraft(conversation.title || ''); }}
                    className="text-sm text-blue-600 hover:text-blue-800 active:text-blue-900 px-2 py-1 min-h-[36px]"
                  >
                    Edit
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Members */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Members ({conversation.participants?.length || 0})
              </label>
              {isOwner && !showAdd && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="text-sm text-blue-600 hover:text-blue-800 active:text-blue-900 px-2 py-1 min-h-[36px]"
                >
                  + Add
                </button>
              )}
            </div>

            {/* Add picker */}
            {showAdd && (
              <div className="mb-3 p-3 bg-gray-50 rounded-lg">
                <div className="flex gap-2 items-center mb-2">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search to add member…"
                    className="flex-1 px-3 py-2 min-h-[40px] border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-base"
                    autoFocus
                  />
                  <button
                    onClick={() => { setShowAdd(false); setSearch(''); setResults([]); }}
                    className="text-sm text-gray-600 hover:text-gray-900 px-2 py-1 min-h-[36px]"
                  >
                    Cancel
                  </button>
                </div>
                {search.length > 0 && (
                  <div className="max-h-48 overflow-y-auto bg-white rounded border border-gray-200">
                    {isSearching ? (
                      <div className="p-3 text-sm text-gray-500 text-center">Searching…</div>
                    ) : results.length === 0 ? (
                      <div className="p-3 text-sm text-gray-500 text-center">No matches</div>
                    ) : (
                      results.map(u => (
                        <button
                          key={u.id}
                          onClick={() => handleAdd(u)}
                          disabled={busyUserId === u.id}
                          className="w-full text-left p-3 hover:bg-gray-50 active:bg-gray-100 border-b border-gray-100 last:border-b-0 disabled:opacity-50 min-h-[56px] flex items-center gap-3"
                        >
                          <div className="w-9 h-9 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 font-medium text-sm">
                            {(u.name || u.email).charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{u.name || u.email}</div>
                            <div className="text-xs text-gray-500 truncate">{u.email}</div>
                          </div>
                          <span className="text-blue-600 text-sm font-medium">Add</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Member list */}
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
              {(conversation.participants || []).map(p => {
                const u = p.user;
                const isMe = u.id === currentUser?.userId;
                const pres = presence.get(u.id);
                const canRemove = isOwner && !isMe;
                return (
                  <li key={u.id} className="p-3 flex items-center gap-3 min-h-[56px]">
                    <div className="relative">
                      <div className="w-9 h-9 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 font-medium text-sm">
                        {(u.name || u.email).charAt(0).toUpperCase()}
                      </div>
                      <div className="absolute -bottom-0.5 -right-0.5">
                        <PresenceIndicator status={pres?.status || u.presenceStatus} size="sm" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {u.name || u.email}{isMe && <span className="text-gray-400 font-normal"> (you)</span>}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {u.email}{p.role === 'owner' && <span className="ml-1 text-blue-600">· owner</span>}
                      </div>
                    </div>
                    {canRemove && (
                      <button
                        onClick={() => handleRemove(u.id, u.name || u.email)}
                        disabled={busyUserId === u.id}
                        className="text-sm text-red-600 hover:text-red-800 active:text-red-900 px-2 py-1 min-h-[36px] disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Leave */}
          {!isOwner && (
            <section>
              <button
                onClick={handleLeave}
                className="w-full px-4 py-3 min-h-[44px] border border-red-300 text-red-600 rounded-lg hover:bg-red-50 active:bg-red-100 font-medium transition-colors"
              >
                Leave group
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
