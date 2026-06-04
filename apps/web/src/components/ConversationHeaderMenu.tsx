import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Conversation, User } from '../api';
import { useChat } from '../contexts/ChatContext';

interface Props {
  conversation: Conversation;
  directParticipant: User | null;
  onViewProfile: () => void;
}

// Mute duration presets (bmp.5). Mirrors the mobile mute UX.
const MUTE_PRESETS: { label: string; value: () => Date | 'always' }[] = [
  { label: 'Mute for 1 hour', value: () => new Date(Date.now() + 60 * 60 * 1000) },
  { label: 'Mute for 8 hours', value: () => new Date(Date.now() + 8 * 60 * 60 * 1000) },
  { label: 'Mute for 1 week', value: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  { label: 'Mute until I turn it back on', value: () => 'always' },
];

export function ConversationHeaderMenu({ conversation, directParticipant, onViewProfile }: Props) {
  const { setConversationMute } = useChat();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const isMuted = !!conversation.mutedUntil;

  const handleMute = async (value: Date | 'always' | null) => {
    setOpen(false);
    try {
      await setConversationMute(conversation.id, value);
      toast.success(value === null ? 'Unmuted' : 'Muted');
    } catch {
      /* surfaced in context */
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Conversation options"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 11.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 17a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg dark:shadow-black/40 py-1">
          {directParticipant && !directParticipant.isBot && (
            <button
              type="button"
              onClick={() => { setOpen(false); onViewProfile(); }}
              className="block w-full px-4 py-2.5 text-left text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800"
            >
              View profile
            </button>
          )}
          {isMuted ? (
            <button
              type="button"
              onClick={() => handleMute(null)}
              className="block w-full px-4 py-2.5 text-left text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800"
            >
              🔔 Unmute
            </button>
          ) : (
            <>
              <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Mute</div>
              {MUTE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => handleMute(p.value())}
                  className="block w-full px-4 py-2.5 text-left text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800"
                >
                  {p.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
