/**
 * One set of link rules for chat bubbles, Back channel posts and Stream
 * entries (docs/message-links.md):
 *
 * - `[label](destination)` shows the label; a bare web address shows itself.
 * - A web destination becomes a link only if `safeMessageUrl` accepts it.
 * - A `file:` address or a path on someone's own computer becomes a *path*:
 *   never a link (a browser cannot open it from a web page), but something a
 *   reader can copy.
 * - Any other destination (`javascript:`, `data:`, `vbscript:`, unknown
 *   schemes, addresses carrying credentials) leaves the text exactly as typed.
 *
 * No character is lost: joining every part's `source` gives the input back.
 */
import { messageLinks, safeMessageUrl } from './messageLinks';

export type LinkPart =
  | { t: 'text'; source: string }
  | { t: 'link'; source: string; label: string; url: string; start: number }
  | { t: 'path'; source: string; label: string; path: string; start: number };

export const ROOTS = String.raw`(?:~\/|\/(?:Users|home|Volumes|private|var|tmp|etc|opt|usr|mnt|srv|Library|Applications)\/|[A-Za-z]:\\)`;
/**
 * Where a path on someone's own computer starts, such as /Users/sam/plan.html.
 * Only well-known roots count, so ordinary slashes ("and/or", "/shrug", dates) stay text.
 */
const PATH_START = new RegExp(`${ROOTS}\\S`, 'g');
const IS_LOCAL_PATH = new RegExp(`^${ROOTS}[^\\n]+$`);
// Label and destination lengths are bounded and neither may hold a newline, so matching stays linear.
// A destination may hold one level of balanced parentheses, as in https://example.org/a_(b).
// A file: or local-path destination may contain spaces and runs to the closing parenthesis, so one
// that fails the checks below leaves the whole [label](destination) as typed, not a stray piece of it.
const MARKDOWN_LINK = new RegExp(String.raw`\[([^\]\n]{1,300})\]\((<[^>\n]{1,2000}>|file:[^)\n]{1,2000}|${ROOTS}[^)\n]{1,2000}|(?:[^()\s]|\([^()\s]{0,500}\)){1,2000})\)`, 'gi');
const BARE_FILE_URL = /file:\/\/[^\s<>"“”‘’`]+/gi;
/**
 * Characters a copied path must never carry: control characters, the invisible
 * and direction-changing ones that make a path read as something else, and the
 * characters a shell acts on (a path is meant for a file dialog, but may be
 * pasted into a terminal). Text containing them is left exactly as typed.
 */
const UNSAFE_IN_PATH = /[\u0000-\u001f\u007f\u0085\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff;|&$`<>"!{}]/;

/**
 * Text that goes on, after a space, to a flag, an assignment or a second path is a command
 * ("/tmp/x -o /tmp/y", "/usr/bin/env X=1 /tmp/x.sh"), not one path. "My Notes - Draft" is fine:
 * the dash must be followed by a character to count as a flag.
 */
const LOOKS_LIKE_COMMAND = /\s(?:-\S|[\/~]|[A-Za-z]:\\|\S*=)/;
/** Whether text may be offered as a path to copy. */
const copyable = (path: string) => !UNSAFE_IN_PATH.test(path) && !LOOKS_LIKE_COMMAND.test(path);

/** The path a `file:` address names, or null when it is not a usable one. */
export function fileUrlToPath(url: string): string | null {
  // It must be written file://…, and its path may not begin with a second pair of slashes:
  // file:/tmp/a is not an address anyone meant, and file:////server/share names another machine.
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(url.trim());
  if (!match) return null;
  let path: string;
  // A '%' that does not start a %XX escape is a literal character of the file name
  // ("100% done.txt"); escapes that do not decode as text still leave the address as typed.
  try { path = decodeURIComponent(match[2]!.replace(/%(?![0-9a-f]{2})/gi, '%25')); } catch { return null; }
  const host = match[1] ?? '';
  // Checked after decoding, so %2F cannot smuggle the second slash (or a backslash) in.
  if (/^[\\/][\\/]/.test(path) || !/[^/]/.test(path) || !copyable(path) || UNSAFE_IN_PATH.test(host) || /[\s@:]/.test(host)) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  // A file on another machine (file://server/share/…) is not a local path; it stays as typed.
  return host && host.toLowerCase() !== 'localhost' ? null : path;
}

/**
 * Where the path that starts at `start` ends, or -1 when nothing there should be offered as a
 * path. The caller has found a path root at `start`.
 */
export function pathEnd(content: string, start: number): number {
  const before = start ? content[start - 1]! : '\n';
  if (!/[\s(]/.test(before)) return -1;
  const lineEnd = content.indexOf('\n', start);
  const line = content.slice(start, lineEnd < 0 ? content.length : lineEnd);
  // A line that is nothing but a path may contain spaces. It is one when it starts the line and
  // either looks like a file or folder ("/Users/sam/my notes/plan.html", "/Users/sam/my notes/":
  // ends in a separator, or in an extension on a name with few spaces), or reads like a name
  // rather than a sentence ("/Users/sam/My Projects/Index Folder": no closing punctuation and no
  // lowercase word after a space). A line that goes on to a flag, an assignment or a second path
  // ("/tmp/a -o /tmp/b", "/usr/bin/env X=1 /tmp/x.sh") is a command, not a path. Anywhere else,
  // such as "/tmp/x is where I left it", the path ends at the next space.
  const whole = line.trimEnd();
  const name = whole.slice(Math.max(whole.lastIndexOf('/'), whole.lastIndexOf('\\')) + 1);
  const looksLikeFile = /[\\/]$/.test(whole) || (/\.[A-Za-z0-9]{1,8}$/.test(whole) && name.split(' ').length <= 4);
  const looksLikeName = !/[.,;:!?]$/.test(whole) && !/\s[a-z]/.test(whole);
  const wholeLine = before === '\n' && !LOOKS_LIKE_COMMAND.test(whole) && (looksLikeFile || looksLikeName);
  let text = wholeLine ? whole : line.split(/\s/, 1)[0]!;
  if (!wholeLine) text = text.replace(/[.,;:!?)]+$/, '');
  return text.length > 3 && !UNSAFE_IN_PATH.test(text) ? start + text.length : -1;
}

export function filePaths(content: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  PATH_START.lastIndex = 0;
  for (let m = PATH_START.exec(content); m; m = PATH_START.exec(content)) {
    const end = pathEnd(content, m.index);
    if (end > 0) found.push({ start: m.index, end });
    PATH_START.lastIndex = end > 0 ? end : m.index + 1;
  }
  return found;
}

/** What a `[label](destination)` points at: a web address, a local path, or nothing usable. */
export function linkDestination(raw: string): { url: string } | { path: string } | null {
  const dest = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw.trim();
  if (/^file:/i.test(dest)) { const path = fileUrlToPath(dest); return path ? { path } : null; }
  if (IS_LOCAL_PATH.test(dest)) return copyable(dest) ? { path: dest } : null;
  const url = safeMessageUrl(dest);
  return url ? { url } : null;
}

type Mark = { start: number; end: number; part?: LinkPart };

export function linkParts(content: string): LinkPart[] {
  const marks: Mark[] = [];
  const free = (start: number, end: number) => !marks.some(mark => mark.start < end && start < mark.end);

  // 1. [label](destination). A match with an unusable destination is still claimed,
  //    so nothing inside it is promoted by the later passes.
  MARKDOWN_LINK.lastIndex = 0;
  for (let m = MARKDOWN_LINK.exec(content); m; m = MARKDOWN_LINK.exec(content)) {
    const start = m.index, end = start + m[0].length, source = m[0], label = m[1]!;
    const dest = label.trim() ? linkDestination(m[2]!) : null;
    marks.push({ start, end, part: !dest ? undefined
      : 'url' in dest ? { t: 'link', source, label, url: dest.url, start }
      // A link labelled with its own address shows the path it copies, like a bare address.
      : { t: 'path', source, label: label.trim() === m[2]!.trim() ? dest.path : label, path: dest.path, start } });
  }
  // 2. Bare web addresses.
  for (const link of messageLinks(content)) {
    if (free(link.start, link.end)) marks.push({ start: link.start, end: link.end, part: { t: 'link', source: link.text, label: link.text, url: link.url, start: link.start } });
  }
  // 3. Bare file: addresses.
  BARE_FILE_URL.lastIndex = 0;
  for (let m = BARE_FILE_URL.exec(content); m; m = BARE_FILE_URL.exec(content)) {
    const start = m.index;
    if (start && !/[\s(<]/.test(content[start - 1]!)) continue;
    const source = m[0].replace(/[.,;:!?)'…]+$/, '');
    const path = fileUrlToPath(source);
    if (path && free(start, start + source.length)) marks.push({ start, end: start + source.length, part: { t: 'path', source, label: path, path, start } });
  }
  // 4. Bare paths.
  for (const span of filePaths(content)) {
    const source = content.slice(span.start, span.end);
    if (free(span.start, span.end)) marks.push({ ...span, part: { t: 'path', source, label: source, path: source, start: span.start } });
  }

  marks.sort((a, b) => a.start - b.start);
  const parts: LinkPart[] = [];
  let cursor = 0;
  const text = (source: string) => {
    if (!source) return;
    const last = parts[parts.length - 1];
    if (last?.t === 'text') last.source += source; else parts.push({ t: 'text', source });
  };
  for (const mark of marks) {
    text(content.slice(cursor, mark.start));
    if (mark.part) parts.push(mark.part); else text(content.slice(mark.start, mark.end));
    cursor = mark.end;
  }
  text(content.slice(cursor));
  return parts;
}

/** The web destinations in a message, with the text each is shown under (message link actions). */
export function webLinks(content: string): Array<{ text: string; url: string }> {
  return linkParts(content).flatMap(part => part.t === 'link' ? [{ text: part.label, url: part.url }] : []);
}
