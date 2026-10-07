/**
 * Raw "Ink & Paper" palette values — see colors.ts for the design rationale.
 *
 * This module deliberately imports nothing from `react-native`: keeping it
 * dependency-free is what lets the H2 contrast contract in contrast.test.ts
 * assert these values directly. Runtime scheme resolution lives in colors.ts.
 */
export type ColorScheme = 'light' | 'dark';

export const palette = {
  light: {
    background: '#faf6ef',         // paper
    surface: '#fffdf8',            // bright paper (cards, headers, composer)
    surfaceElevated: '#f3ecdf',    // pressed paper
    border: '#e7ddcc',             // paper edge
    divider: '#e7ddcc',
    textPrimary: '#1c1917',        // ink
    textSecondary: '#78716c',      // faded ink
    textMetadata: '#6f6760',       // readable small text on paper (>= 5.15:1)
    textMuted: '#a8a29e',          // pencil
    primary: '#b3541e',            // burnt sienna — THE accent
    onPrimary: '#ffffff',           // content on primary
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
    background: '#242321',         // midnight ink
    surface: '#2b2a27',
    surfaceElevated: '#34332f',
    border: '#46433d',
    divider: '#46433d',
    textPrimary: '#d6cfc4',        // paper-white
    textSecondary: '#b0a89c',
    textMetadata: '#b0a89c',       // readable small text on dark surfaces (>= 5.82:1)
    textMuted: '#7d7466',
    primary: '#d49b74',            // sienna, lifted for dark ground
    onPrimary: '#26231f',           // dark ink meets contrast on lifted sienna
    primaryActive: '#e08b5c',
    bubbleOwn: '#4a4139',          // paper block on ink ground (mirror of light)
    bubbleOwnText: '#e4dbcf',
    bubbleOther: '#2b2a27',
    bubbleOtherText: '#d6cfc4',
    presenceAvailable: '#6da57c',
    presenceAway: '#d99a4e',
    presenceBusy: '#d05f4b',
    presenceOffline: '#7d7466',
    danger: '#d05f4b',
    dangerMuted: 'rgba(208, 95, 75, 0.16)',
    primaryMuted: '#39312b',
  },
};

export type Colors = typeof palette.light;
