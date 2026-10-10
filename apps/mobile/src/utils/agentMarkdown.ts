/**
 * A deliberately small Markdown subset for agent (bot) messages
 * (OpenChat-eo3n.5). Agents write **bold**, lists, `code` and links; showing
 * those characters literally is what made agent replies look broken. No
 * dependency: blocks are paragraphs, headings, bullet and numbered lists,
 * quotes and fenced code; inline is bold, italic, code, [label](url) and bare
 * URLs. Anything else stays plain text. Only http(s) links without
 * credentials become tappable.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; c: Inline[]; href: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'heading'; c: Inline[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] };

/** A tappable destination, or null. Adds https:// to www. links. */
export function safeHref(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const TRAILING = /[.,;:!?)\]'"’”]+$/;
// Order matters: code spans first so their contents are literal.
const INLINE_SOURCE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v });
  };
  let last = 0;
  // A fresh regex per call: parseInline recurses, and a shared global
  // regex's lastIndex would be reset by the inner call.
  const INLINE = new RegExp(INLINE_SOURCE.source, 'g');
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) {
      const href = safeHref(m[3]!);
      if (href) out.push({ t: 'link', c: parseInline(m[2]), href });
      else pushText(m[0]);
    } else if (m[4] !== undefined || m[5] !== undefined) out.push({ t: 'bold', c: parseInline((m[4] ?? m[5])!) });
    else if (m[6] !== undefined || m[7] !== undefined) out.push({ t: 'italic', c: parseInline((m[6] ?? m[7])!) });
    else if (m[8] !== undefined) {
      // Sentence punctuation after a URL stays outside the link.
      const trail = m[8].match(TRAILING)?.[0] ?? '';
      const raw = trail ? m[8].slice(0, -trail.length) : m[8];
      const href = safeHref(raw);
      if (href) out.push({ t: 'link', c: [{ t: 'text', v: raw }], href }); else pushText(raw);
      pushText(trail);
    }
  }
  pushText(text.slice(last));
  return out;
}

export function parseAgentMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) { flush(); blocks.push({ t: 'heading', c: parseInline(heading[1]!.replace(/\s+#+\s*$/, '')) }); continue; }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) { flush(); blocks.push({ t: 'quote', c: parseInline(quote[1]!) }); continue; }
    const bullet = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s{0,3}(\d{1,9})[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      const ordered = !!numbered;
      const prev = blocks[blocks.length - 1];
      const item = parseInline((bullet ? bullet[1] : numbered![2])!);
      if (prev?.t === 'list' && prev.ordered === ordered) prev.items.push(item);
      else blocks.push({ t: 'list', ordered, start: numbered ? Number(numbered[1]) : 1, items: [item] });
      continue;
    }
    // A continuation line indented under a list item joins that item.
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev?.t === 'list' && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1]!.push({ t: 'text', v: ' ' }, ...parseInline(line.trim()));
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}
