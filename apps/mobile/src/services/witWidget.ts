/**
 * World Issue Tracker in-app feedback on web (/app), menu-launched install:
 * WIT docs/widget-host-integration-guide.md#menu-launched-identity-verified-install.
 *
 * The loader renders no launcher (data-trigger="none"); "Send feedback" in the
 * desktop account menu and in Settings opens the panel. Native platforms keep
 * FeedbackModal, which files through services/witNativeFeedback.ts.
 * Signed-in reports carry a verified sender: the widget's token
 * getter asks the server for a 15-minute create-issue-only token
 * (POST /api/feedback/wit-token); null means the report files anonymously.
 */
import { Platform } from 'react-native';
import { setNativeFeedbackUser } from './witNativeFeedback';

const WIDGET_SRC = 'https://worldissuetracker.com/widget/wit-feedback.js';
export const WIT_FEEDBACK_TRACKER = 'openchat-feedback';

type WitWidgetToken = { token: string | null; expires_at?: number };
type TokenGetter = () => Promise<string | null>;
type Queue = Array<[string, unknown[]]>;
type WitFeedbackApi = Record<string, ((...args: unknown[]) => unknown) | undefined>;

const isWeb = (): boolean => Platform.OS === 'web' && typeof document !== 'undefined';
const w = (): { WitFeedback?: WitFeedbackApi; __witFeedbackQueue?: Queue } =>
  window as unknown as { WitFeedback?: WitFeedbackApi; __witFeedbackQueue?: Queue };

function call(method: string, ...args: unknown[]): void {
  const api = w().WitFeedback;
  if (api) { api[method]?.(...args); return; }
  (w().__witFeedbackQueue ||= []).push([method, args]);
}

/** Injects the loader once (web only). Returns false on native. */
let injected = false;
export function ensureWitWidget(): boolean {
  if (!isWeb()) return false;
  if (injected || document.querySelector('script[src*="wit-feedback.js"]')) return true;
  injected = true;
  // expo-constants is loaded lazily so importing this module (ChatContext)
  // never pulls Expo's native runtime into non-web code or unit tests.
  void import('expo-constants')
    .then((m) => m.default.expoConfig?.version ?? '', () => '')
    .then((version) => {
      const script = document.createElement('script');
      script.src = WIDGET_SRC;
      script.dataset.trackerSlug = WIT_FEEDBACK_TRACKER;
      script.dataset.trigger = 'none';
      script.dataset.app = 'OpenChat';
      script.dataset.appVersion = version;
      document.head.appendChild(script);
    });
  return true;
}

/** Opens the feedback panel on web. Returns false on native (use FeedbackModal). */
export function openWitFeedback(): boolean {
  if (!ensureWitWidget()) return false;
  call('open');
  return true;
}

/**
 * Signed in: give the widget a getter backed by `fetchToken` (cached until a
 * minute before expiry). Signed out: null, so the next report is anonymous.
 */
export function setWitFeedbackUser(fetchToken: (() => Promise<WitWidgetToken>) | null): void {
  // Queued only: the loader is injected on the first open, so pages that never
  // open feedback (e.g. the chat embedded in Unlinked) load nothing extra.
  // Native: FeedbackModal posts to WIT itself with the same token source.
  if (!isWeb()) { setNativeFeedbackUser(fetchToken); return; }
  let cached: WitWidgetToken | null = null;
  const getter: TokenGetter | null = fetchToken
    ? async () => {
        if (cached?.token && (cached.expires_at ?? 0) * 1000 - Date.now() > 60_000) return cached.token;
        try { cached = await fetchToken(); } catch { cached = null; }
        return cached?.token ?? null;
      }
    : null;
  call('setUserToken', getter);
}
