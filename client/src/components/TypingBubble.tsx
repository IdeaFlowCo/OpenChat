/**
 * TypingBubble — animated three-dot "someone is typing" indicator.
 *
 * Renders an iMessage-style bubble with three staggered bouncing dots.
 * When multiple people are typing, shows a text label above the bubble:
 *   - 1 person  → "Alice is typing…"
 *   - 2+ people → "Alice and 2 others are typing…"
 *
 * Auto-clear: callers should remove the bubble when no one is typing.
 * The 3-second fallback timer lives in MessageList to avoid prop-drilling.
 */

import type { CSSProperties } from 'react';

interface TypingBubbleProps {
  /** Display names of users who are currently typing (non-self only). */
  names: string[];
}

export function TypingBubble({ names }: TypingBubbleProps) {
  if (names.length === 0) return null;

  const label =
    names.length === 1
      ? `${names[0]} is typing…`
      : `${names[0]} and ${names.length - 1} other${names.length - 1 === 1 ? '' : 's'} are typing…`;

  const dotStyle = (delayMs: number): CSSProperties => ({
    animation: `typing-dot 1.2s ease-in-out ${delayMs}ms infinite`,
  });

  return (
    <div className="flex flex-col items-start gap-1 py-1">
      <span className="text-xs text-gray-400 dark:text-slate-500 px-1 select-none">
        {label}
      </span>
      <div className="flex items-center gap-1 bg-gray-100 dark:bg-slate-800 px-4 py-3 rounded-2xl rounded-bl-md">
        <span
          className="block w-2 h-2 rounded-full bg-gray-400 dark:bg-slate-400"
          style={dotStyle(0)}
        />
        <span
          className="block w-2 h-2 rounded-full bg-gray-400 dark:bg-slate-400"
          style={dotStyle(200)}
        />
        <span
          className="block w-2 h-2 rounded-full bg-gray-400 dark:bg-slate-400"
          style={dotStyle(400)}
        />
      </div>
    </div>
  );
}
