import { messageLinks } from './messageLinks';

export type StreamTextPart =
  | { t: 'text'; text: string }
  | { t: 'link'; text: string; url: string; start: number }
  | { t: 'path'; text: string };

/**
 * A file location on someone's own computer, such as /Users/sam/notes/plan.html.
 * It cannot open for a reader, so it is shown as a path rather than left
 * looking like a link that does nothing. Only well-known roots count, so
 * ordinary slashes ("and/or", "/shrug", dates) stay text.
 */
const PATH_START = /(?:~\/|\/(?:Users|home|Volumes|private|var|tmp|etc|opt|usr|mnt|srv|Library|Applications)\/|[A-Za-z]:\\)\S/g;

export function filePaths(content: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  PATH_START.lastIndex = 0;
  for (let m = PATH_START.exec(content); m; m = PATH_START.exec(content)) {
    const start = m.index;
    const before = start ? content[start - 1]! : '\n';
    if (!/[\s(]/.test(before)) continue;
    const lineEnd = content.indexOf('\n', start);
    const line = content.slice(start, lineEnd < 0 ? content.length : lineEnd);
    // A line that is nothing but a path may contain spaces ("/Users/sam/My Notes/plan.html"):
    // it starts the line and ends in a file name or a slash. Anywhere else, such as
    // "/tmp/x is where I left it", the path ends at the next space.
    const wholeLine = before === '\n' && /(?:\.[A-Za-z0-9]{1,8}|[\\/])\s*$/.test(line);
    let text = wholeLine ? line.trimEnd() : line.split(/\s/, 1)[0]!;
    if (!wholeLine) text = text.replace(/[.,;:!?)]+$/, '');
    if (text.length > 3) found.push({ start, end: start + text.length });
    PATH_START.lastIndex = start + Math.max(text.length, 1);
  }
  return found;
}

/** Split Stream text into plain runs, web links and local file paths, losing no character. */
export function streamTextParts(content: string): StreamTextPart[] {
  const links = messageLinks(content);
  const paths = filePaths(content).filter(path => !links.some(link => link.start < path.end && path.start < link.end));
  const marks = [
    ...links.map(link => ({ start: link.start, end: link.end, part: { t: 'link' as const, text: link.text, url: link.url, start: link.start } })),
    ...paths.map(path => ({ ...path, part: { t: 'path' as const, text: content.slice(path.start, path.end) } })),
  ].sort((a, b) => a.start - b.start);
  const parts: StreamTextPart[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) parts.push({ t: 'text', text: content.slice(cursor, mark.start) });
    parts.push(mark.part);
    cursor = mark.end;
  }
  if (cursor < content.length) parts.push({ t: 'text', text: content.slice(cursor) });
  return parts;
}
