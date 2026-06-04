/**
 * Responsive breakpoints (OpenChat-601).
 *
 * Single source of truth for the desktop / mobile switch in the web build.
 *
 * useIsDesktop() returns true only on the web at widths >= 900px. On native
 * (iOS / Android) it always returns false, since native lays out per the
 * Conversations stack regardless of screen size. We rely on RN's
 * useWindowDimensions() (which works on RN-web too) rather than CSS media
 * queries so the same hook can drive JS-level decisions (master-detail
 * switch, hover affordances, keyboard shortcut binding).
 *
 * Why 900: at 768px (portrait iPad) a 320px sidebar leaves only 448px for
 * the chat pane — cramped reading + composing. 900px keeps portrait iPads
 * on the single-column mobile layout (comfortable typing) and lets
 * landscape iPads + laptops + desktops get the master-detail view (ample
 * room for both columns). Confirmed independently by Gemini + Codex
 * second-opinion reviews on 2026-06-01.
 */
import { useWindowDimensions, Platform } from 'react-native';

export const BREAKPOINT_DESKTOP = 900;

export function useIsDesktop(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= BREAKPOINT_DESKTOP;
}
