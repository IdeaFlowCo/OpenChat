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
    background: '#16130f',         // midnight ink
    surface: '#201c16',
    surfaceElevated: '#2a251d',
    border: '#3a332a',
    divider: '#3a332a',
    textPrimary: '#ede5d8',        // paper-white
    textSecondary: '#a89f8f',
    textMetadata: '#a09688',       // readable small text on dark surfaces (>= 5.82:1)
    textMuted: '#7d7466',
    primary: '#d97742',            // sienna, lifted for dark ground
    onPrimary: '#1c1917',           // dark ink meets contrast on lifted sienna
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

export type Colors = typeof palette.light;
