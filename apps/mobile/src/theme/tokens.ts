/**
 * Layout and type tokens under the "Ink & Paper" palette (UX system pass,
 * OpenChat-eo3n.1, from the 2026-10-09 audit).
 *
 * The palette was never the problem; the missing system underneath it was:
 * 25 font sizes, 23 corner radii and per-file padding. Every new or migrated
 * style takes its size, spacing and corner from here, and
 * `apps/mobile/eslint.config.mjs` rejects new `fontSize`/hex literals outside
 * `src/theme/`. Like palette.ts, this module imports nothing from
 * `react-native`, so it stays testable and shareable.
 *
 * Hierarchy rule: try weight and colour on one size before reaching for a
 * new size. Chat bubbles keep their own 16/22 body.
 */
import type { Colors } from './palette';

type Weight = '400' | '500' | '600' | '700';
export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: Weight;
  letterSpacing?: number;
  textTransform?: 'uppercase';
}

/** Type scale: base 15, ratio about 1.2. */
export const type = {
  /** Eyebrows and section labels (uppercase, tracked). */
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
  /** Timestamps, counts, provenance. */
  meta: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  /** Field labels, chip and small-button text. */
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  /** Message bubbles only. */
  bubble: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  /** Nav titles, row titles, button text. */
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  /** Login, profile name and empty states only. */
  display: { fontSize: 28, lineHeight: 34, fontWeight: '600', letterSpacing: -0.4 },
} as const satisfies Record<string, TypeStyle>;

/** 4-pt spacing scale. Density is tool-tight: card padding 12 (16 on desktop),
 * list rows 12 vertical, 8 between cards, 24 between sections, gutter 16. */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

/** Four corners only. sm: chips inside bars and inline inputs; md: cards,
 * buttons, inputs; lg: sheets and the QR panel; pill: avatars, tag chips. */
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

/** Minimum touch target for anything tappable. */
export const touchTarget = 44;

/** Sheets and menus carry the only shadow; cards are a hairline, not a lift. */
export const sheetShadow = {
  shadowColor: '#1c1917',
  shadowOpacity: 0.12,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
} as const;

/**
 * Colour roles over the palette. Pick by role, not by look:
 * - `accent` is for the one primary button per screen, selected state and
 *   links in body copy. It is not the colour of every action word.
 * - `accentSoft` tints selected chips and rows; text on it is `onAccentSoft`.
 * - `agent` marks agent-authored content (ochre, no new hue); `ask` and
 *   `offer` colour those eyebrows.
 * - `input` sits darker than the card it is on, never lighter.
 */
export function roles(c: Colors) {
  return {
    canvas: c.background,
    card: c.surface,
    input: c.surfaceElevated,
    pressed: c.surfaceElevated,
    line: c.border,
    text: c.textPrimary,
    textSecondary: c.textSecondary,
    textMeta: c.textMetadata,
    decoration: c.textMuted,
    accent: c.primary,
    onAccent: c.onPrimary,
    accentSoft: c.primaryMuted,
    /** Text on `accentSoft`; plain `accent` measures 4.1:1 there in light mode. */
    onAccentSoft: c.primaryActive,
    agent: c.presenceAway,
    ask: c.primary,
    offer: c.presenceAvailable,
    danger: c.danger,
    dangerSoft: c.dangerMuted,
  };
}
export type Roles = ReturnType<typeof roles>;
