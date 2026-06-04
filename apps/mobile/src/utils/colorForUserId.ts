/**
 * Deterministic, per-user color for sender labels (WhatsApp-style).
 *
 * Goals:
 *  - Same userId always maps to the same hue across sessions and devices.
 *  - Saturation/lightness are tuned per scheme so the color is readable on the
 *    chat surface without clashing with the bubble background.
 *  - We avoid pure red/green so they don't get confused with status/error UI.
 *
 * Returns an HSL string suitable for use as a React Native text color.
 */

export type Scheme = 'light' | 'dark';

/**
 * 32-bit FNV-1a hash. Fast, deterministic, no deps. We only need ~360 buckets.
 */
function hash(str: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime mul, kept in unsigned range
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function colorForUserId(id: string | undefined | null, scheme: Scheme = 'light'): string {
  if (!id) return scheme === 'dark' ? '#94a3b8' : '#475569';
  const hue = hash(id) % 360;
  // On light backgrounds we want darker, more saturated text (good contrast).
  // On dark backgrounds we want lighter, less saturated (avoid harsh neon).
  const saturation = scheme === 'dark' ? 55 : 65;
  const lightness = scheme === 'dark' ? 70 : 38;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
