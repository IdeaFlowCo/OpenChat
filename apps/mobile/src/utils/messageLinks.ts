export interface MessageLink { text: string; url: string; start: number; end: number }

/**
 * Bare domains people type without a scheme, such as unlinked.ai or
 * ideaflow.app. A fixed list rather than every TLD, so file names (notes.md,
 * app.py, index.html) and sentences missing a space stay plain text.
 */
export const BARE_DOMAIN_TLDS = [
  'com', 'net', 'org', 'edu', 'gov', 'io', 'ai', 'app', 'dev', 'co', 'me', 'us', 'uk', 'ca', 'de', 'fr', 'es',
  'it', 'nl', 'se', 'ch', 'eu', 'au', 'nz', 'jp', 'in', 'br', 'xyz', 'info', 'biz', 'tv', 'fm', 'gg', 'ly', 'so',
  'to', 'cc', 'vc', 'tech', 'cloud', 'online', 'site', 'blog', 'wiki', 'studio', 'design', 'social',
];
// Bounded label count keeps matching linear on long dotted runs.
export const BARE_DOMAIN = String.raw`(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}(?:${BARE_DOMAIN_TLDS.join('|')})(?![a-z0-9-]|\.[a-z0-9])(?::\d{1,5})?(?:[/?#][^\s<>"“”‘’\`]*)?`;

const BARE_DOMAIN_ONLY = new RegExp(`^${BARE_DOMAIN}$`, 'i');
export const isBareDomain = (value: string) => BARE_DOMAIN_ONLY.test(value);

/**
 * Characters that are not seen, or that change how the text around them reads. An address or a
 * path carrying one may not be what it looks like, so it is left exactly as typed. Shared with
 * the Ideaflow Dashboard: control characters, soft hyphen, combining grapheme joiner, Arabic
 * letter mark, zero-width and direction marks, line and paragraph separators, direction
 * embeddings and isolates, word joiner and invisible operators, variation selectors, and the
 * byte-order mark.
 */
export const INVISIBLE = /[\u0000-\u001f\u007f\u0085\u00ad\u034f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff]/;
const WHITESPACE_OR_BACKSLASH = /[\s\\]/;
/**
 * Whether the character at `index` is hidden (and not an ordinary tab or line break). Nothing is
 * offered right beside one: "exam<hidden>ple.org" must not become a link to ple.org that reads
 * as example.org.
 */
export const hiddenAt = (content: string, index: number) => {
  const ch = content[index];
  return ch !== undefined && ch !== '\t' && ch !== '\n' && ch !== '\r' && INVISIBLE.test(ch);
};

/** Only web URLs are actionable. Never promote an arbitrary pasted scheme. */
export function safeMessageUrl(value: string): string | null {
  const url = /^www\./i.test(value) || isBareDomain(value) ? `https://${value}` : value;
  // No whitespace, control, invisible or direction-changing character may hide in an address.
  if (!/^https?:\/\//i.test(url) || WHITESPACE_OR_BACKSLASH.test(url) || INVISIBLE.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
/**
 * Drops sentence punctuation and unmatched closing brackets from the end of an address, in one
 * pass. (Counting brackets again for every character dropped made a message ending in thousands
 * of brackets take seconds to draw.)
 */
export function trimLink(text: string): string {
  const count: Record<string, number> = {};
  for (const ch of text) if ('()[]{}'.includes(ch)) count[ch] = (count[ch] ?? 0) + 1;
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1]!;
    if (".,!?;:'…".includes(ch)) end--;
    else if (CLOSERS[ch] && (count[ch] ?? 0) > (count[CLOSERS[ch]!] ?? 0)) { count[ch]!--; end--; }
    else break;
  }
  return text.slice(0, end);
}

export function messageLinks(content: string): MessageLink[] {
  const links: MessageLink[] = [];
  const candidates = new RegExp(String.raw`(?:https?:\/\/|www\.)[^\s<>"“”‘’\`]+|${BARE_DOMAIN}`, 'gi');
  for (const match of content.matchAll(candidates)) {
    const start = match.index!;
    // Do not turn the tail of javascript:..., an email, or another URL into a link.
    if (start && /[\w@/:=+.-]/.test(content[start - 1])) continue;
    if (hiddenAt(content, start - 1) || hiddenAt(content, start + match[0].length)) continue;
    const text = trimLink(match[0]);
    const url = safeMessageUrl(text);
    if (url) links.push({ text, url, start, end: start + text.length });
  }
  return links;
}

/** Let the browser keep its native link and selected-text context menus. */
export function preserveBrowserMenu(target: EventTarget | null, selection: string): boolean {
  return !!selection || !!(target as Element | null)?.closest?.('a[href]');
}
