/**
 * Bottom-edge ownership for a chat thread on a phone.
 *
 * At phone widths a pushed thread hides the tab bar, as Messages and WhatsApp
 * do (`narrow && chatCanGoBack` in App.tsx's AuthedTabs). The tab bar is what
 * normally absorbs the home-indicator inset, so the thread's composer has to
 * clear it itself or it sits on the home indicator.
 */

/** Below this window width App.tsx hides the tab bar inside a pushed thread. */
export const PHONE_THREAD_MAX_WIDTH = 768;

export function threadBottomInset({ platform, embedded, windowWidth, stackIndex, safeAreaBottom }: {
  platform: string;
  /** Embedded in the wide master-detail pane, where the tab bar stays. */
  embedded: boolean;
  windowWidth: number;
  /** Index of the thread's route in its stack; 0 means nothing beneath, so the tab bar stays. */
  stackIndex: number;
  safeAreaBottom: number;
}): number {
  // Web has no home indicator to clear in the RN layout, and Android's
  // keyboard resize keeps reporting the navigation-bar inset while open.
  if (platform !== 'ios' || embedded) return 0;
  if (windowWidth >= PHONE_THREAD_MAX_WIDTH || stackIndex <= 0) return 0;
  return Math.max(0, safeAreaBottom);
}
