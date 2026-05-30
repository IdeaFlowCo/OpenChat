/**
 * Theme tokens shared with the web app's dark-mode palette (per OpenChat-ri4).
 * Keep these in sync with client/src/index.css + tailwind defaults so cross-
 * platform users see the same colors.
 */
import { Appearance, ColorSchemeName } from 'react-native';

export type ColorScheme = 'light' | 'dark';

function normalize(scheme: ColorSchemeName | ColorScheme | undefined | null): ColorScheme {
  return scheme === 'dark' ? 'dark' : 'light';
}

const palette = {
  light: {
    background: '#f9fafb',         // gray-50
    surface: '#ffffff',            // white
    surfaceElevated: '#f3f4f6',    // gray-100
    border: '#e5e7eb',             // gray-200
    divider: '#f3f4f6',            // gray-100
    textPrimary: '#111827',        // gray-900
    textSecondary: '#6b7280',      // gray-500
    textMuted: '#9ca3af',          // gray-400
    primary: '#3b82f6',            // blue-500
    primaryActive: '#1d4ed8',      // blue-700
    bubbleOwn: '#3b82f6',
    bubbleOwnText: '#ffffff',
    bubbleOther: '#f3f4f6',        // gray-100
    bubbleOtherText: '#111827',    // gray-900
    presenceAvailable: '#22c55e',
    presenceAway: '#eab308',
    presenceBusy: '#ef4444',
    presenceOffline: '#9ca3af',
    danger: '#dc2626',
  },
  dark: {
    background: '#020617',         // slate-950
    surface: '#0f172a',            // slate-900
    surfaceElevated: '#1e293b',    // slate-800
    border: '#1e293b',             // slate-800
    divider: '#1e293b',
    textPrimary: '#f1f5f9',        // slate-100
    textSecondary: '#94a3b8',      // slate-400
    textMuted: '#64748b',          // slate-500
    primary: '#3b82f6',
    primaryActive: '#1d4ed8',
    bubbleOwn: '#3b82f6',
    bubbleOwnText: '#ffffff',
    bubbleOther: '#1e293b',        // slate-800
    bubbleOtherText: '#f1f5f9',    // slate-100
    presenceAvailable: '#22c55e',
    presenceAway: '#eab308',
    presenceBusy: '#ef4444',
    presenceOffline: '#475569',
    danger: '#f87171',
  },
};

export function getColors(scheme?: ColorSchemeName | ColorScheme): typeof palette.light {
  return palette[normalize(scheme ?? Appearance.getColorScheme())];
}

export type Colors = typeof palette.light;
