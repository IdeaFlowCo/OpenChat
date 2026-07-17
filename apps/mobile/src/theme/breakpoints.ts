/**
 * Responsive breakpoints (OpenChat-601).
 *
 * Single source of truth for the desktop / mobile switch.
 *
 * useIsDesktop() returns true at widths >= 900px on web. On native, it also
 * requires a tablet-sized short side so large phones in landscape stay on the
 * single-column stack while iPad landscape / large screens use master-detail.
 * We rely on RN's useWindowDimensions() (which works on RN-web too) rather
 * than CSS media queries so the same hook can drive JS-level decisions
 * (master-detail switch, hover affordances, keyboard shortcut binding).
 *
 * Why 900: at 768px (portrait iPad) a 320px sidebar leaves only 448px for
 * the chat pane — cramped reading + composing. 900px keeps portrait iPads
 * on the single-column mobile layout (comfortable typing) and lets
 * landscape iPads + laptops + desktops get the master-detail view (ample
 * room for both columns). Confirmed independently by Gemini + Codex
 * second-opinion reviews on 2026-06-01.
 */
import { Platform, useWindowDimensions } from 'react-native';

export const BREAKPOINT_DESKTOP = 900;
// Separates tablets from landscape phones before enabling native split view.
export const BREAKPOINT_TABLET_MIN_SHORT_SIDE = 600;

export function useIsDesktop(): boolean {
  const { width, height } = useWindowDimensions();

  if (Platform.OS === 'web') {
    return width >= BREAKPOINT_DESKTOP;
  }

  return (
    width >= BREAKPOINT_DESKTOP &&
    Math.min(width, height) >= BREAKPOINT_TABLET_MIN_SHORT_SIDE
  );
}
