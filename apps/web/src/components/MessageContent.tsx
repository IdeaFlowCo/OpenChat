import { Fragment } from 'react';

interface Props {
  content: string;
  isOwn: boolean;
  // Display names of conversation participants, used to highlight @mentions (bmp.8).
  mentionNames: string[];
}

// URL matcher (http/https). Kept conservative to avoid eating trailing punctuation.
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,!?:;)\]])/g;

/**
 * Render message text with two enhancements (bmp.8):
 *   1. Linkify http(s) URLs.
 *   2. Highlight @mentions — an @ followed by a participant display name.
 * We highlight against known participant names so we don't bold arbitrary
 * "@" usage (emails, handles for non-members).
 */
export function MessageContent({ content, isOwn, mentionNames }: Props) {
  // Build a mention regex from participant names (escaped), longest-first so
  // "@Ann Lee" wins over "@Ann". Falls back to a generic @word if no names.
  const names = mentionNames
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mentionRe = names.length
    ? new RegExp(`@(?:${names.join('|')})`, 'g')
    : null;

  const linkClass = isOwn ? 'underline text-white' : 'underline text-blue-600 dark:text-blue-400';
  const mentionClass = isOwn
    ? 'font-semibold text-white bg-white/20 rounded px-0.5'
    : 'font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/40 rounded px-0.5';

  // First split on URLs, then within non-URL chunks split on mentions.
  const renderWithMentions = (text: string, keyBase: string) => {
    if (!mentionRe) return text;
    const out: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    mentionRe.lastIndex = 0;
    let i = 0;
    while ((m = mentionRe.exec(text)) !== null) {
      if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
      out.push(<span key={`${keyBase}-m${i}`} className={mentionClass}>{m[0]}</span>);
      last = m.index + m[0].length;
      i++;
    }
    if (last < text.length) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last)}</Fragment>);
    return out;
  };

  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  let idx = 0;
  while ((m = URL_RE.exec(content)) !== null) {
    if (m.index > last) parts.push(<Fragment key={`u-t${idx}`}>{renderWithMentions(content.slice(last, m.index), `t${idx}`)}</Fragment>);
    parts.push(
      <a key={`u-l${idx}`} href={m[0]} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {m[0]}
      </a>
    );
    last = m.index + m[0].length;
    idx++;
  }
  if (last < content.length) parts.push(<Fragment key={`u-t${idx}`}>{renderWithMentions(content.slice(last), `t${idx}`)}</Fragment>);

  return <p className="break-words whitespace-pre-wrap">{parts}</p>;
}
