import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_WITHOUT_TEXT,
  VOICE_WITHOUT_TRANSCRIPT,
  assistantTextForMessage,
} from '../src/services/assistantContext.js';

const AUDIO = JSON.stringify([{ type: 'audio', url: 'https://x/voice.m4a', mimeType: 'audio/x-m4a' }]);
const IMAGE = JSON.stringify([{ type: 'image', url: 'https://x/p.jpg', mimeType: 'image/jpeg' }]);

describe('assistantTextForMessage', () => {
  it('passes typed text through unchanged', () => {
    expect(assistantTextForMessage({ content: ' hello ', attachments: null })).toBe('hello');
  });

  it('reads a voice note (empty content) as its transcript', () => {
    expect(
      assistantTextForMessage({ content: '', transcript: 'what is on my calendar', attachments: AUDIO })
    ).toBe('[Voice message] what is on my calendar');
  });

  it('keeps a voice note visible when it has no transcript', () => {
    expect(assistantTextForMessage({ content: '', transcript: null, attachments: AUDIO }))
      .toBe(VOICE_WITHOUT_TRANSCRIPT);
  });

  it('keeps a text-less photo visible', () => {
    expect(assistantTextForMessage({ content: '', attachments: IMAGE })).toBe(ATTACHMENT_WITHOUT_TEXT);
  });

  it('accepts already-parsed attachments and ignores malformed ones', () => {
    expect(assistantTextForMessage({ content: '', attachments: JSON.parse(AUDIO) }))
      .toBe(VOICE_WITHOUT_TRANSCRIPT);
    expect(assistantTextForMessage({ content: '', attachments: '{not json' })).toBe('');
  });

  it('stays empty for a message with neither text nor attachments', () => {
    expect(assistantTextForMessage({ content: '', attachments: null })).toBe('');
  });
});
