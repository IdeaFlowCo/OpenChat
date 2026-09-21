/**
 * Executable contract for the H2 contrast findings of the 2026-09-20 visual
 * design audit. The audit measured that white-on-dark-sienna (3.15:1) and the
 * "pencil" muted token (2.34:1 light / 3.68:1 dark) fall below the 4.5:1
 * normal-text benchmark, so `onPrimary` and `textMetadata` were introduced.
 * These assertions stop either token from silently drifting back under target.
 */
import { describe, expect, it } from 'vitest';
import { palette } from './palette';

const NORMAL_TEXT_MIN = 4.5;

function channelLuminance(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance for an opaque `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  expect(value, `${hex} must be a six-digit opaque hex colour`).toHaveLength(6);
  const [r, g, b] = [0, 2, 4].map(i => channelLuminance(parseInt(value.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio. Opaque pairs only — do not use for alpha blends. */
function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('contrast helper', () => {
  it('matches the reference ratios the audit published', () => {
    // Black on white is the definitional 21:1 upper bound.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    // The audit's regression case: white on dark-mode sienna measured 3.15:1.
    expect(contrastRatio('#ffffff', '#d97742')).toBeCloseTo(3.15, 2);
  });
});

describe.each(['light', 'dark'] as const)('%s theme contrast', scheme => {
  const c = palette[scheme];

  it('renders content on the accent above the normal-text threshold', () => {
    expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
    expect(contrastRatio(c.onPrimary, c.primaryActive)).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
  });

  it('keeps metadata legible on every ground it is painted on', () => {
    for (const ground of [c.background, c.surface, c.surfaceElevated] as const) {
      expect(contrastRatio(c.textMetadata, ground)).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
    }
  });

  it('keeps primary text well clear of the threshold', () => {
    expect(contrastRatio(c.textPrimary, c.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(c.textPrimary, c.surface)).toBeGreaterThanOrEqual(7);
  });

  it('reads own-bubble text against its own fill', () => {
    expect(contrastRatio(c.bubbleOwnText, c.bubbleOwn)).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
  });

  it('still exposes the softer muted tone for decoration only', () => {
    // `textMuted` is deliberately below the threshold; it exists for dividers,
    // disabled states and decoration. Asserting that keeps the two roles from
    // being treated as interchangeable.
    expect(contrastRatio(c.textMuted, c.background)).toBeLessThan(NORMAL_TEXT_MIN);
  });
});
