import { isUnlinkedEmbed } from '../services/unlinkedEmbed';
/**
 * Theme tokens — "Ink & Paper" design direction (design-audit 2026-09-02,
 * chosen by Jacob from the three from-scratch directions).
 *
 * Identity: warm paper ground, near-monochrome ink, ONE burnt-sienna accent,
 * serif display type (see typography.ts). Own bubbles are ink-on-paper in
 * light mode and paper-on-ink in dark mode — the palette's signature move.
 *
 * The old palette was stock Tailwind blue-500/gray, shared with the legacy
 * web client. The legacy client intentionally keeps its own look for now
 * (Jacob scoped it out); the RN app is the flagship surface.
 */
import { Appearance, ColorSchemeName } from 'react-native';
import { palette, type ColorScheme } from './palette';

export type { Colors, ColorScheme } from './palette';

function normalize(scheme: ColorSchemeName | ColorScheme | undefined | null): ColorScheme {
  return scheme === 'dark' ? 'dark' : 'light';
}

export function getColors(scheme?: ColorSchemeName | ColorScheme): typeof palette.light {
  if (isUnlinkedEmbed()) return { ...palette.light, background: '#f5f6fc', surface: '#ffffff', surfaceElevated: '#eef0fa', border: '#e6e8ef', divider: '#e6e8ef', textPrimary: '#16181d', textSecondary: '#606576', textMetadata: '#606576', primary: '#4349c4', primaryActive: '#353ba4', primaryMuted: '#ebecfa', bubbleOwn: '#4349c4', bubbleOwnText: '#ffffff', bubbleOther: '#ffffff', bubbleOtherText: '#16181d' };
  return palette[normalize(scheme ?? Appearance.getColorScheme())];
}
