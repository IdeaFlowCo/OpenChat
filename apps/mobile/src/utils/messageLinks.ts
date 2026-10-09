export interface MessageLink { text: string; url: string; start: number; end: number }

/** Only web URLs are actionable. Never promote an arbitrary pasted scheme. */
export function safeMessageUrl(value: string): string | null {
  const url = /^www\./i.test(value) ? `https://${value}` : value;
  if (!/^https?:\/\//i.test(url) || /[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}

export function messageLinks(content: string): MessageLink[] {
  const links: MessageLink[] = [];
  const candidates = /(?:https?:\/\/|www\.)[^\s<>"“”‘’`]+/gi;
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
