import { describe, expect, it } from 'vitest';
import { draftBody } from '../src/services/contextHosted.js';

// OpenChat-wdy2: the owner approves exact text, so model framing must not ship.
describe('draftBody', () => {
  it('drops an introductory framing line and wrapping quotes', () => {
    expect(draftBody('Here\'s a proposed reply for you to review:\n\n"Hi! Dr. Kim is great."')).toBe('Hi! Dr. Kim is great.');
  });
  it('keeps an ordinary reply untouched', () => {
    expect(draftBody('Leo drives past Chabot at 7:50 on Tue/Thu.')).toBe('Leo drives past Chabot at 7:50 on Tue/Thu.');
  });
  it('keeps a reply whose first line merely contains a colon', () => {
    expect(draftBody('Options: Saturday or Sunday\nEither works for Priya.')).toBe('Options: Saturday or Sunday\nEither works for Priya.');
  });
});
