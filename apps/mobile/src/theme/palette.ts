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
    privateInk: '#4a3fb0',         // the viewer-only layer: never the accent, never a chat colour
    privateSoft: '#edebfb',
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
    privateInk: '#b7b0f6',
    privateSoft: '#302d47',
  },
};

/**
 * "Slate": the default look. Neutral cool greys, one blue accent, own messages
 * in the accent as in native messengers. Ink & Paper above remains a choice
 * under Settings › Appearance, and a stored choice is always kept (see look.ts).
 */
export const slatePalette: typeof palette = {
  light: {
    background: '#f6f7f9',
    surface: '#ffffff',
    surfaceElevated: '#eceef2',
    border: '#e2e5ea',
    divider: '#e2e5ea',
    textPrimary: '#15171c',
    textSecondary: '#5a6070',
    textMetadata: '#596070',
    textMuted: '#9ba1ad',
    primary: '#2f5fe0',
    onPrimary: '#ffffff',
    primaryActive: '#2448b8',
    bubbleOwn: '#2f5fe0',
    bubbleOwnText: '#ffffff',
    bubbleOther: '#ffffff',
    bubbleOtherText: '#15171c',
    presenceAvailable: '#1f9d61',
    presenceAway: '#b97a12',
    presenceBusy: '#d64545',
    presenceOffline: '#9ba1ad',
    danger: '#c93a3a',
    dangerMuted: 'rgba(201, 58, 58, 0.10)',
    primaryMuted: 'rgba(47, 95, 224, 0.10)',
    privateInk: '#7a34c2',
    privateSoft: '#f1eafb',
  },
  dark: {
    background: '#111318',
    surface: '#181b21',
    surfaceElevated: '#22262e',
    border: '#2e333d',
    divider: '#2e333d',
    textPrimary: '#e6e8ec',
    textSecondary: '#a3a9b6',
    textMetadata: '#a3a9b6',
    textMuted: '#6b7280',
    primary: '#7d9bff',
    onPrimary: '#0e1220',
    primaryActive: '#9ab1ff',
    bubbleOwn: '#3558d6',
    bubbleOwnText: '#ffffff',
    bubbleOther: '#22262e',
    bubbleOtherText: '#e6e8ec',
    presenceAvailable: '#4cc38a',
    presenceAway: '#e0a84a',
    presenceBusy: '#f07070',
    presenceOffline: '#6b7280',
    danger: '#f07070',
    dangerMuted: 'rgba(240, 112, 112, 0.16)',
    primaryMuted: '#1f2740',
    privateInk: '#c7a6f5',
    privateSoft: '#2a2140',
  },
};

export const palettes = { paper: palette, slate: slatePalette } as const;
export type Look = keyof typeof palettes;

export type Colors = typeof palette.light;
