import { describe, expect, it } from 'vitest';
import { findSecretaryAnswer, secretaryMatchScore } from '../src/services/secretaryMatcher.js';

describe('secretaryMatchScore', () => {
  it('matches a routine question by its salient whole-word keyword', () => {
    expect(secretaryMatchScore("Hey, remind me what your address is again?", 'What is my address?')).toBe(1);
  });

  it('does not match a short or partial keyword', () => {
    expect(secretaryMatchScore('Can you do it?', 'Do I?')).toBe(0);
    expect(secretaryMatchScore('Please add this', 'What is my address?')).toBe(0);
  });

  it('requires both salient words for a two-keyword card', () => {
    expect(secretaryMatchScore('What is the guest wifi password?', 'Guest wifi details')).toBe(1);
    expect(secretaryMatchScore('Is there guest parking?', 'Guest wifi details')).toBe(0);
  });

  it('requires at least two thirds coverage for longer cards', () => {
    expect(secretaryMatchScore('When is weekly team standup?', 'Weekly team standup schedule')).toBeGreaterThan(0);
    expect(secretaryMatchScore('When is the weekly event?', 'Weekly team standup schedule')).toBe(0);
  });
});

describe('findSecretaryAnswer', () => {
  const answers = [
    { id: 'address', question: 'What is my address?', answer: '123 Main St.' },
    { id: 'wifi', question: 'Guest wifi details', answer: 'Use the guest network.' },
  ];

  it('returns the approved answer card and never synthesizes content', () => {
    expect(findSecretaryAnswer('Could you remind me of your address?', answers)).toEqual(answers[0]);
  });

  it('returns null for an unmatched request', () => {
    expect(findSecretaryAnswer('Can you call me?', answers)).toBeNull();
  });
});
