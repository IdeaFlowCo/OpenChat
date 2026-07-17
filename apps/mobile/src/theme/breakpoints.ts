/**
 * Responsive breakpoints (OpenChat-601).
 *
 * Single source of truth for the desktop / mobile switch.
 *
 * useIsDesktop() returns true at widths >= 900px on web and native. This
 * lets iPad landscape / large screens use the master-detail view while
 * phones and narrow iPad Split View panes stay on the single-column stack.
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
import { useWindowDimensions } from 'react-native';

export const BREAKPOINT_DESKTOP = 900;

export function useIsDesktop(): boolean {
  const { width } = useWindowDimensions();
  return width >= BREAKPOINT_DESKTOP;
}
