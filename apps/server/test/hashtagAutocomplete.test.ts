import { describe, expect, it } from 'vitest';
import {
  applyHashtagSuggestion,
  findActiveHashtag,
} from '../../mobile/src/utils/hashtagAutocomplete.js';

describe('composer hashtag token handling', () => {
  it('finds an empty hashtag trigger and a case-preserving typed prefix', () => {
    expect(findActiveHashtag('Share this #', 12)).toEqual({ query: '', start: 11, end: 12 });
    expect(findActiveHashtag('Share this #De', 14)).toEqual({ query: 'De', start: 11, end: 14 });
  });

  it('finds a tag at the caret and replaces the entire token during middle edits', () => {
    const text = 'A #desgn choice';
    const active = findActiveHashtag(text, 6);

    expect(active).toEqual({ query: 'des', start: 2, end: 8 });
    expect(applyHashtagSuggestion(text, active!, 'design')).toEqual({
      text: 'A #design choice',
      cursor: 10,
    });
  });

  it('stops suggesting once the user finishes or types a non-storable tag character', () => {
    expect(findActiveHashtag('#decision shipped', 17)).toBeNull();
    expect(findActiveHashtag('#two words', 10)).toBeNull();
  });

  it('completes Unicode, numeric, underscore and hyphen tags', () => {
    for (const tag of ['équipe', 'q4-goals', 'two_words', '项目2']) {
      const text = `#${tag}`;
      const active = findActiveHashtag(text, Math.min(3, text.length));
      expect(active).toEqual({ query: tag.slice(0, 2), start: 0, end: text.length });
      expect(applyHashtagSuggestion(text, active!, tag).text).toBe(`${text} `);
    }
  });

  it('leaves arbitrary new tags freely typable', () => {
    expect(findActiveHashtag('New #UnseenTag', 14)).toEqual({
      query: 'UnseenTag',
      start: 4,
      end: 14,
    });
  });
});
