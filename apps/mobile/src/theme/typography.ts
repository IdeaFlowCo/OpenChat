/**
 * Typography tokens — "Ink & Paper" (design-audit 2026-09-02).
 *
 * Display (headers, chat titles, section titles) uses a serif to give the app
 * a literary voice; body text stays the system sans for legibility. No custom
 * font files — Georgia ships with iOS/macOS, Android falls back to its system
 * 'serif' (Noto Serif), web gets a serif stack. Zero binary/native cost, so
 * this is OTA-safe.
 */
import { Platform } from 'react-native';

export const serif = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
}) as string;

/** Nav-bar / screen titles. */
export const displayTitle = {
  fontFamily: serif,
  fontWeight: '600' as const,
  letterSpacing: 0.1,
};

/** Small, letterspaced caps labels (kind badges, section headers). */
export const capsLabel = {
  fontSize: 10.5,
  fontWeight: '700' as const,
  letterSpacing: 1.1,
  textTransform: 'uppercase' as const,
};
