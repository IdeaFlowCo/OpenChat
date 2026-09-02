import { describe, expect, it } from 'vitest';
import { normalizeSpokenHashtags } from '../src/services/normalizeSpokenHashtags.js';

describe('normalizeSpokenHashtags', () => {
  it('converts a chained spoken tag pair (Jacob 2026-09-02 voice note)', () => {
    expect(
      normalizeSpokenHashtags("I'm testing a voicenote. Hashtag, community house, Incepto house.")
    ).toBe("I'm testing a voicenote. #CommunityHouse #InceptoHouse.");
  });

  it('keeps only the type word for known type-tags', () => {
    expect(normalizeSpokenHashtags('Hashtag todo call mom tomorrow.')).toBe('#todo call mom tomorrow.');
    expect(normalizeSpokenHashtags('Remember hashtag fact the meeting moved to 3pm.')).toBe(
      'Remember #fact the meeting moved to 3pm.'
    );
  });

  it('leaves text without spoken hashtags untouched', () => {
    expect(normalizeSpokenHashtags('no tags here at all')).toBe('no tags here at all');
    expect(normalizeSpokenHashtags('the hashtag culture is weird honestly')).toBe(
      'the hashtag culture is weird honestly'
    );
  });

  it('handles "hash tag" with a space', () => {
    expect(normalizeSpokenHashtags('Hash tag, community house.')).toBe('#CommunityHouse.');
  });
});
