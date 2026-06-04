import { useMemo } from 'react';
import { User } from '../api';

export interface MentionCandidate {
  userId: string;
  displayName: string;
  email: string;
}

interface Props {
  query: string;
  participants: { user: User; role: string }[];
  excludeUserId?: string;
  onSelect: (candidate: MentionCandidate) => void;
}

// Floating @mention autocomplete shown above the composer in group chats (bmp.8).
// Mirrors apps/mobile/src/components/MentionAutocomplete.tsx.
export function MentionAutocomplete({ query, participants, excludeUserId, onSelect }: Props) {
  const candidates = useMemo<MentionCandidate[]>(() => {
    const lower = query.toLowerCase();
    return participants
      .filter((p) => p.user.id !== excludeUserId)
      .map((p): MentionCandidate => ({
        userId: p.user.id,
        displayName: p.user.name || p.user.email.split('@')[0] || p.user.email,
        email: p.user.email,
      }))
      .filter((c) => c.displayName.toLowerCase().includes(lower) || c.email.toLowerCase().includes(lower))
      .slice(0, 8);
  }, [query, participants, excludeUserId]);

  if (candidates.length === 0) return null;

  return (
    <div className="mb-2 max-h-60 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg dark:shadow-black/40">
      {candidates.map((c) => (
        <button
          key={c.userId}
          type="button"
          // Use onMouseDown so selection fires before the textarea blur.
          onMouseDown={(e) => { e.preventDefault(); onSelect(c); }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-slate-800"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-300 dark:bg-slate-700 text-xs font-medium text-gray-600 dark:text-slate-300">
            {c.displayName.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-gray-900 dark:text-slate-100">{c.displayName}</span>
            <span className="block truncate text-xs text-gray-500 dark:text-slate-400">{c.email}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
