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

/** Only web URLs are actionable. Never promote an arbitrary pasted scheme. */
export function safeMessageUrl(value: string): string | null {
  const url = /^www\./i.test(value) || isBareDomain(value) ? `https://${value}` : value;
  if (!/^https?:\/\//i.test(url) || /[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}

export function messageLinks(content: string): MessageLink[] {
  const links: MessageLink[] = [];
  const candidates = new RegExp(String.raw`(?:https?:\/\/|www\.)[^\s<>"“”‘’\`]+|${BARE_DOMAIN}`, 'gi');
  for (const match of content.matchAll(candidates)) {
    const start = match.index!;
    // Do not turn the tail of javascript:..., an email, or another URL into a link.
    if (start && /[\w@/:=+.-]/.test(content[start - 1])) continue;
    let text = match[0];
    let previous: string;
    do {
      previous = text;
      text = text.replace(/[.,!?;:'…]+$/, '');
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (text.endsWith(close) && text.split(close).length > text.split(open).length) {
          text = text.slice(0, -1);
        }
      }
    } while (text !== previous);
    const url = safeMessageUrl(text);
    if (url) links.push({ text, url, start, end: start + text.length });
  }
  return links;
}

/** Let the browser keep its native link and selected-text context menus. */
export function preserveBrowserMenu(target: EventTarget | null, selection: string): boolean {
  return !!selection || !!(target as Element | null)?.closest?.('a[href]');
}
