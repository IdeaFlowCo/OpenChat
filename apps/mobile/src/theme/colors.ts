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

export type ColorScheme = 'light' | 'dark';

function normalize(scheme: ColorSchemeName | ColorScheme | undefined | null): ColorScheme {
  return scheme === 'dark' ? 'dark' : 'light';
}

const palette = {
  light: {
    background: '#faf6ef',         // paper
    surface: '#fffdf8',            // bright paper (cards, headers, composer)
    surfaceElevated: '#f3ecdf',    // pressed paper
    border: '#e7ddcc',             // paper edge
    divider: '#e7ddcc',
    textPrimary: '#1c1917',        // ink
    textSecondary: '#78716c',      // faded ink
    textMuted: '#a8a29e',          // pencil
    primary: '#b3541e',            // burnt sienna — THE accent
    primaryActive: '#8f4318',
    bubbleOwn: '#1c1917',          // ink block
    bubbleOwnText: '#faf6ef',
    bubbleOther: '#fffdf8',
    bubbleOtherText: '#1c1917',
    presenceAvailable: '#4a7c59',  // moss
    presenceAway: '#c07b28',       // ochre
    presenceBusy: '#b3402e',       // brick
    presenceOffline: '#a8a29e',
    danger: '#b3402e',
    dangerMuted: 'rgba(179, 64, 46, 0.12)',
    primaryMuted: 'rgba(179, 84, 30, 0.13)',
  },
  dark: {
    background: '#16130f',         // midnight ink
    surface: '#201c16',
    surfaceElevated: '#2a251d',
    border: '#3a332a',
    divider: '#3a332a',
    textPrimary: '#ede5d8',        // paper-white
    textSecondary: '#a89f8f',
    textMuted: '#7d7466',
    primary: '#d97742',            // sienna, lifted for dark ground
    primaryActive: '#e08b5c',
    bubbleOwn: '#ede5d8',          // paper block on ink ground (mirror of light)
    bubbleOwnText: '#1c1917',
    bubbleOther: '#201c16',
    bubbleOtherText: '#ede5d8',
    presenceAvailable: '#6da57c',
    presenceAway: '#d99a4e',
    presenceBusy: '#d05f4b',
    presenceOffline: '#7d7466',
    danger: '#d05f4b',
    dangerMuted: 'rgba(208, 95, 75, 0.16)',
    primaryMuted: 'rgba(217, 119, 66, 0.16)',
  },
};

export function getColors(scheme?: ColorSchemeName | ColorScheme): typeof palette.light {
  return palette[normalize(scheme ?? Appearance.getColorScheme())];
}

export type Colors = typeof palette.light;
