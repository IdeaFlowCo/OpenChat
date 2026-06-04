import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, User } from '../api';
import { useChat } from '../contexts/ChatContext';
import { PresenceIndicator } from './PresenceIndicator';
import { BotBadge } from './BotBadge';

interface Props {
  open: boolean;
  onClose: () => void;
  user: User;
}

const REPORT_REASONS = ['spam', 'inappropriate', 'abuse', 'other'] as const;

// DM contact profile panel (bmp.6). Slides up as a modal sheet; shows
// identity + presence, and (for non-bot users) block + report actions.
export function ContactProfilePanel({ open, onClose, user }: Props) {
  const { presence, blockUser, setActiveConversation } = useChat();
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  if (!open) return null;

  const pres = presence.get(user.id);
  const displayName = user.name || user.email || 'Unknown';
  const presenceLine =
    pres?.statusMessage ||
    (pres?.status === 'available' ? 'Available' : null) ||
    user.statusMessage ||
    null;

  const handleBlock = async () => {
    if (busy) return;
    if (!window.confirm(`Block ${displayName}? You won't receive messages from them. You can unblock from Settings.`)) return;
    setBusy(true);
    try {
      await blockUser(user.id);
      onClose();
      setActiveConversation(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to block.');
    } finally {
      setBusy(false);
    }
  };

  const handleReport = async (reason: string) => {
    setReportOpen(false);
    try {
      await api.submitReport({ targetType: 'user', targetId: user.id, reason });
      toast.success("Thanks — we've received your report.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit report.');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Contact profile"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex w-full flex-col rounded-t-2xl bg-white dark:bg-slate-900 shadow-xl md:max-w-md md:rounded-2xl">
        <div className="flex items-center justify-end px-4 py-2">
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col items-center px-6 pb-2">
          <div className="relative">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gray-300 dark:bg-slate-700 text-3xl font-semibold text-gray-600 dark:text-slate-300">
              {displayName.charAt(0).toUpperCase()}
            </div>
            <div className="absolute bottom-1 right-1">
              <PresenceIndicator status={pres?.status || user.presenceStatus} size="lg" />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-1">
            <h2 className="text-xl font-bold text-gray-900 dark:text-slate-100">{displayName}</h2>
            <BotBadge user={user} />
          </div>
          {user.email && user.email !== displayName && (
            <p className="text-sm text-gray-500 dark:text-slate-400">{user.email}</p>
          )}
          {presenceLine && <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{presenceLine}</p>}
        </div>

        {!user.isBot && (
          <div className="m-4 overflow-hidden rounded-lg border border-gray-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setReportOpen((o) => !o)}
              className="block w-full border-b border-gray-100 dark:border-slate-800 px-4 py-3 text-left text-sm font-medium text-gray-900 dark:text-slate-100 hover:bg-gray-50 dark:hover:bg-slate-800/50"
            >
              Report user
            </button>
            {reportOpen && (
              <div className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 px-4 py-2">
                <div className="flex flex-wrap gap-2">
                  {REPORT_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => handleReport(r)}
                      className="rounded-full border border-gray-300 dark:border-slate-600 px-3 py-1 text-xs capitalize text-gray-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={handleBlock}
              disabled={busy}
              className="block w-full px-4 py-3 text-left text-sm font-medium text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-slate-800/50 disabled:opacity-50"
            >
              {busy ? 'Blocking…' : 'Block user'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
