export interface ActiveHashtag {
  /** Typed prefix between '#' and the caret. */
  query: string;
  /** Offset of the '#'. */
  start: number;
  /** End of the whole hashtag token, including any suffix after the caret. */
  end: number;
}

/**
 * Find a hashtag token intersecting the caret. This supports the common
 * end-of-message case plus editing an existing tag in the middle of a draft.
 * The grammar intentionally mirrors the server extractor: ASCII letters.
 */
export function findActiveHashtag(text: string, cursor: number): ActiveHashtag | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const beforeCaret = text.slice(0, safeCursor);
  const match = beforeCaret.match(/(?:^|[^a-zA-Z])#([a-zA-Z]*)$/);
  if (!match) return null;

  const query = match[1] ?? '';
  const start = safeCursor - query.length - 1;
  const suffix = text.slice(safeCursor).match(/^[a-zA-Z]*/)?.[0] ?? '';
  return { query, start, end: safeCursor + suffix.length };
}

export function applyHashtagSuggestion(
  text: string,
  active: ActiveHashtag,
  tag: string,
): { text: string; cursor: number } {
  const insertion = `#${tag} `;
  // Reuse the token's existing separator rather than producing two spaces
  // when completing a tag in the middle of a draft.
  const replaceEnd = text[active.end] === ' ' ? active.end + 1 : active.end;
  const nextText = text.slice(0, active.start) + insertion + text.slice(replaceEnd);
  return { text: nextText, cursor: active.start + insertion.length };
}
