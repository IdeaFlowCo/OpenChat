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
 * the Ideaflow Dashboard: control characters, next line, line and paragraph separators, every
 * Unicode default-ignorable code point (soft hyphen, zero-width and direction marks, Hangul and
 * Khmer fillers, Mongolian and other variation selectors, word joiner and invisible operators,
 * shorthand and musical format controls, tag characters), the braille blank and the interlinear
 * annotation marks.
 *
 * Written out by code point, with the three astral ranges as surrogate pairs, so it needs neither
 * the `u` flag nor Unicode property escapes from the JavaScript engine. A test compares it with
 * \p{Default_Ignorable_Code_Point} for every code point.
 */
export const INVISIBLE = new RegExp(
  '[\\u0000-\\u001f\\u007f\\u0085\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028\\u2029'
  + '\\u202a-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb]'
  // U+1BCA0–1BCA3, U+1D173–1D17A, U+E0000–E0FFF
  + '|\\ud82f[\\udca0-\\udca3]|\\ud834[\\udd73-\\udd7a]|[\\udb40-\\udb43][\\udc00-\\udfff]',
);
const WHITESPACE_OR_BACKSLASH = /[\s\\]/;
const isHigh = (ch: string | undefined) => ch !== undefined && ch >= '\ud800' && ch <= '\udbff';
const isLow = (ch: string | undefined) => ch !== undefined && ch >= '\udc00' && ch <= '\udfff';
/**
 * Whether the character at `index` is hidden (and not an ordinary tab or line break). Nothing is
 * offered right beside one: "exam<hidden>ple.org" must not become a link to ple.org that reads
 * as example.org. The whole character is judged, so either half of a surrogate pair answers for
 * the pair.
 */
export const hiddenAt = (content: string, index: number) => {
  const ch = content[index];
  if (ch === undefined || ch === '\t' || ch === '\n' || ch === '\r') return false;
  if (isLow(ch) && isHigh(content[index - 1])) return INVISIBLE.test(content[index - 1] + ch);
  if (isHigh(ch) && isLow(content[index + 1])) return INVISIBLE.test(ch + content[index + 1]);
  return INVISIBLE.test(ch);
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

// No percent sign: an encoded line break or separator must not ride in on the address.
const MAILTO = /^mailto:([A-Za-z0-9._+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24})$/i;
/**
 * A mailto: address that does one thing: open the mail app with one recipient filled in. Nothing
 * is sent. An address carrying a subject, body, cc or bcc is left as typed, so a link cannot
 * pre-write a message or add hidden recipients.
 */
export function safeMailto(value: string): string | null {
  const match = MAILTO.exec(value);
  return match && !match[1]!.includes('..') ? `mailto:${match[1]}` : null;
}

/** Where a written link may lead: a web address or a plain mailto: address. */
export const safeLinkUrl = (value: string): string | null => safeMessageUrl(value) ?? safeMailto(value);

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
