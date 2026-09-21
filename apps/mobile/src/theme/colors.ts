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
  return palette[normalize(scheme ?? Appearance.getColorScheme())];
}
