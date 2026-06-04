/**
 * Deep-link router (OpenChat-84u.1).
 *
 * Listens for incoming URLs from three sources:
 *
 *   1. App cold-start with a URL (Linking.getInitialURL on native, or
 *      window.location.pathname on web)
 *   2. App is already running and the OS hands it a URL (Linking 'url' event,
 *      which fires for openchat:// scheme matches AND Universal Links once
 *      associatedDomains: ['applinks:chat.globalbr.ai'] is enabled)
 *   3. Manual replay after authentication completes (resumePending)
 *
 * For each URL it does the following:
 *
 *   - parseOpenChatUrl() into a typed { type: 'invite' | 'user', ... } shape
 *   - if signed in: navigate immediately to the matching screen
 *   - if NOT signed in: stash the intent in persistent storage; LoginScreen +
 *     post-auth replay picks it up and resumes the action
 *
 * SUPPORTED INPUT URLS:
 *   openchat://invite/<token>
 *   openchat://user/<userId>
 *   https://chat.globalbr.ai/i/<token>
 *   https://chat.globalbr.ai/u/<userId>
 *
 * STORAGE: AsyncStorage on native (survives app kill). On web RN-web shims
 * AsyncStorage to localStorage so it survives an OAuth round-trip in the same
 * browser tab — which is the critical use case (OAuth bounces the user to
 * google.com and back).
 */

import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { navigationRef } from './notifications';
import { parseOpenChatUrl, type ParsedOpenChatUrl } from '../utils/parseOpenChatUrl';
import { getToken } from '../api/client';

const PENDING_INTENT_KEY = 'openchat_pending_intent_v1';

/**
 * The shape we stash for unsigned-in users. Keep simple + serializable so
 * any storage backend (AsyncStorage / sessionStorage / localStorage) works.
 */
export interface PendingIntent {
  /** When the user kicked off the flow — used to expire stale intents. */
  capturedAt: string;
  /** What they were trying to do. */
  intent: ParsedOpenChatUrl;
}

const INTENT_TTL_MS = 30 * 60 * 1000; // 30 minutes — covers OAuth round-trip

// ─── Resolve a URL to a navigation action ─────────────────────────────────────

/**
 * Drive React Navigation to land on the right screen for a parsed deep link.
 * Returns true if a navigation was issued. Safe to call when navigation is
 * not yet ready (silently no-op).
 */
function navigateForIntent(parsed: ParsedOpenChatUrl): boolean {
  if (!navigationRef.isReady()) return false;

  // React Navigation walks the nested tree and finds the route by name —
  // we don't need to spell out Main/ChatsTab/etc. Same approach the
  // notification tap handler uses (services/notifications.ts:166).
  try {
    switch (parsed.type) {
      case 'invite':
        navigationRef.navigate('GroupInvitePreview', { token: parsed.token });
        return true;

      case 'user':
        // Opens contact profile, which has a 'Send DM' action.
        navigationRef.navigate('ContactProfile', { userId: parsed.userId });
        return true;

      case 'unknown':
        return false;
    }
  } catch (err) {
    console.warn('[deepLinks] navigation failed:', err);
    return false;
  }
}

// ─── Stash / resume ───────────────────────────────────────────────────────────

async function stashPending(parsed: ParsedOpenChatUrl): Promise<void> {
  if (parsed.type === 'unknown') return;
  const entry: PendingIntent = {
    capturedAt: new Date().toISOString(),
    intent: parsed,
  };
  try {
    await AsyncStorage.setItem(PENDING_INTENT_KEY, JSON.stringify(entry));
  } catch {
    /* storage write failed; intent will be lost, but auth still works */
  }
}

async function readPending(): Promise<PendingIntent | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_INTENT_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as PendingIntent;
    const captured = Date.parse(entry.capturedAt);
    if (Number.isNaN(captured) || Date.now() - captured > INTENT_TTL_MS) {
      // Expired — drop it.
      await AsyncStorage.removeItem(PENDING_INTENT_KEY);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

async function clearPending(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_INTENT_KEY);
  } catch { /* */ }
}

/**
 * Called by LoginScreen + post-auth bootstrap. If a pending intent was
 * captured before sign-in and is still valid, navigate to it and clear.
 * Returns true if we resumed.
 */
export async function resumePendingIntent(): Promise<boolean> {
  const pending = await readPending();
  if (!pending) return false;
  const ok = navigateForIntent(pending.intent);
  if (ok) await clearPending();
  return ok;
}

// ─── Wire-up ──────────────────────────────────────────────────────────────────

/**
 * Test whether the user is currently authenticated. We read it via the API
 * client's token getter rather than threading ChatContext through here, so
 * this service stays self-contained.
 */
async function isAuthed(): Promise<boolean> {
  try {
    const token = await getToken();
    return !!token;
  } catch {
    return false;
  }
}

/**
 * Handle a single URL we just received from the OS. If signed-in, navigate
 * immediately. Otherwise stash + return so the LoginScreen path can pick it
 * up after OAuth completes.
 */
async function handleIncomingUrl(url: string): Promise<void> {
  const parsed = parseOpenChatUrl(url);
  if (parsed.type === 'unknown') return;

  if (await isAuthed()) {
    // Small delay so navigation has a chance to mount on cold start.
    setTimeout(() => navigateForIntent(parsed), 100);
  } else {
    await stashPending(parsed);
  }
}

/**
 * Install the global deep-link listeners. Call once at app boot. Returns a
 * disposer (mostly for tests; production never disposes).
 */
export function installDeepLinkHandling(): () => void {
  let disposed = false;

  // 1) Cold-start URL — native gives us this via getInitialURL.
  void Linking.getInitialURL().then((url) => {
    if (disposed) return;
    if (url) void handleIncomingUrl(url);
  });

  // 2) Web: cold-start URL also lives in window.location. The 'getInitialURL'
  // path above generally returns null on web, so cover this case explicitly.
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      const here = window.location.href;
      void handleIncomingUrl(here);
    } catch { /* SSR or restricted environment */ }
  }

  // 3) Running-app URL — Linking 'url' event covers both openchat:// and
  // Universal Links (once associatedDomains is in the iOS entitlements).
  const sub = Linking.addEventListener('url', (event) => {
    if (disposed) return;
    if (event?.url) void handleIncomingUrl(event.url);
  });

  return () => {
    disposed = true;
    sub.remove();
  };
}
