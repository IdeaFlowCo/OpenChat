/**
 * Spoken-hashtag normalization (2026-09-02, Jacob's voice-note test).
 *
 * Whisper/Deepgram render a spoken "hashtag community house" as literal text
 * like "Hashtag, community house" — the tag extractor then sees no '#' and
 * captures nothing. This converts spoken hashtags into typed ones so voice
 * notes are first-class for tag → Thought capture:
 *
 *   "Hashtag, community house, Incepto house."
 *     → "#CommunityHouse #InceptoHouse."
 *
 * Heuristics (deliberately conservative):
 * - "hashtag" (case-insensitive, optional trailing comma/colon) starts a tag.
 * - The tag body is the following words up to the next comma / period /
 *   "hashtag" / end, capped at 4 words.
 * - Body words are CamelCased and joined ("community house" → "CommunityHouse").
 * - A comma immediately followed by more words starts ANOTHER tag only when
 *   the previous token was itself a tag (matches "hashtag A, B" dictation
 *   where the speaker chained tags) — otherwise the comma ends tagging.
 */

const TRIGGER = /\bhash\s?tag\b[,.:]?\s*/gi;
const MAX_TAG_WORDS = 4;

// Known single-word type/label tags: when the first word after "hashtag" is
// one of these, the tag is JUST that word and the rest of the segment stays
// as ordinary text ("hashtag todo call mom" → "#todo call mom", not
// "#TodoCallMom").
const SINGLE_WORD_TAGS = new Set([
  'fact', 'decision', 'commitment', 'commit', 'reminder', 'todo',
  'observation', 'thought', 'note', 'idea', 'memorize', 'remember', 'sr',
]);

// "the hashtag culture", "a hashtag on twitter" — prose mentions of the word,
// not spoken tags. A determiner/preposition right before "hashtag" disables
// conversion for that occurrence.
const PROSE_BEFORE = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'every', 'some', 'any',
  'my', 'your', 'his', 'her', 'their', 'our', 'its', 'of', 'with', 'without',
  'each', 'no', 'one',
]);

// Real spoken tags are noun-ish phrases; a function word inside the candidate
// body ("culture IS weird honestly") means it's prose, not a tag.
const FUNCTION_WORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'the', 'a', 'an', 'and',
  'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'it', 'its', "it's",
  'this', 'that', 'very', 'really', 'so', 'not', 'i', 'we', 'you', 'they',
]);

function camel(words: string[]): string {
  return words
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

export function normalizeSpokenHashtags(text: string): string {
  if (!text || !/hash\s?tag/i.test(text)) return text;

  let out = '';
  let last = 0;
  TRIGGER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRIGGER.exec(text)) !== null) {
    // Prose mention? ("the hashtag culture…") — leave untouched.
    const beforeMatch = /([A-Za-z''-]+)\s*$/.exec(text.slice(0, m.index));
    if (beforeMatch && PROSE_BEFORE.has(beforeMatch[1].toLowerCase())) {
      continue;
    }

    out += text.slice(last, m.index);
    const rest = text.slice(m.index + m[0].length);

    // Chained segments: "community house, Incepto house." → two tags.
    // Consume comma-separated word groups while they look like short
    // tag-ish phrases (letters/digits only, few words).
    let consumed = 0;
    const tags: string[] = [];
    const segRe = /^([^,.;!?\n]+)([,.;!?\n]|$)/;
    let cursor = rest;
    while (tags.length < 5) {
      const seg = segRe.exec(cursor);
      if (!seg) break;
      const words = seg[1].trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) break;

      // Known type-tag first word → single-word tag, rest stays as text.
      if (SINGLE_WORD_TAGS.has(words[0].toLowerCase())) {
        tags.push('#' + words[0].toLowerCase());
        const idx = seg[1].indexOf(words[0]);
        consumed += idx + words[0].length;
        // Eat one following space so we don't leave a double space.
        if (cursor[consumed] === ' ') consumed += 0; // spacing handled by join below
        break;
      }

      const tagish =
        words.length <= MAX_TAG_WORDS &&
        words.every((w) => /^[a-zA-Z0-9''-]+$/.test(w)) &&
        (words.length === 1 || !words.some((w) => FUNCTION_WORDS.has(w.toLowerCase())));
      if (!tagish) break;
      tags.push('#' + camel(words));
      consumed += seg[0].length;
      cursor = cursor.slice(seg[0].length);
      // Only keep chaining across commas; a period/… ends the tag run.
      if (seg[2] !== ',') break;
    }

    if (tags.length === 0) {
      // Not tag-shaped — keep the original text untouched.
      out += m[0];
      last = m.index + m[0].length;
      continue;
    }

    // Preserve the terminating punctuation if it was a sentence end.
    const term = consumed > 0 && /[.;!?\n]$/.test(rest.slice(0, consumed)) ? rest.slice(consumed - 1, consumed) : '';
    out += tags.join(' ') + term;
    last = m.index + m[0].length + consumed;
    TRIGGER.lastIndex = last;
  }
  out += text.slice(last);
  return out;
}
