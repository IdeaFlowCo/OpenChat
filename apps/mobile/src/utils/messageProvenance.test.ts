import { describe, expect, it } from 'vitest';
import { showsVisionCaption } from './messageProvenance';

describe('showsVisionCaption', () => {
  it('shows for the sender on a Vision-originated message', () => {
    expect(showsVisionCaption({ senderId: 'u1', provenanceService: 'vision' }, 'u1')).toBe(true);
  });
  it('hides for recipients', () => {
    expect(showsVisionCaption({ senderId: 'u1', provenanceService: 'vision' }, 'u2')).toBe(false);
  });
  it('hides for other or missing provenance', () => {
    expect(showsVisionCaption({ senderId: 'u1', provenanceService: null }, 'u1')).toBe(false);
    expect(showsVisionCaption({ senderId: 'u1' }, 'u1')).toBe(false);
    expect(showsVisionCaption({ senderId: 'u1', provenanceService: 'slack' }, 'u1')).toBe(false);
  });
  it('hides without a signed-in user', () => {
    expect(showsVisionCaption({ senderId: 'u1', provenanceService: 'vision' }, undefined)).toBe(false);
    expect(showsVisionCaption({ senderId: '', provenanceService: 'vision' }, '')).toBe(false);
  });
});
