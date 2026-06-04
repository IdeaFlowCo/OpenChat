// Small visual indicator for agent users in OpenChat. Renders inline next to
// a name (contact picker, message author, conversation header). Sized to sit
// flush with body text. OpenChat-aoy / agent-chat vision.

import { User } from '../api';

interface BotBadgeProps {
  user: Pick<User, 'isBot'> | null | undefined;
  /** Compact variant: just the 🤖 emoji, no "AI" pill. Used in dense lists. */
  compact?: boolean;
  className?: string;
}

export function BotBadge({ user, compact, className }: BotBadgeProps) {
  if (!user?.isBot) return null;

  if (compact) {
    return (
      <span
        title="AI agent"
        aria-label="AI agent"
        className={`inline-block ml-1 text-xs ${className || ''}`}
      >
        🤖
      </span>
    );
  }

  return (
    <span
      title="AI agent"
      aria-label="AI agent"
      className={`inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 ${className || ''}`}
    >
      <span aria-hidden="true">🤖</span>
      <span>AI</span>
    </span>
  );
}
