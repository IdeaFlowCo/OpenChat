// Install-prompt plumbing for OpenChat PWA.
//
// We need to capture `beforeinstallprompt` at app boot (it fires exactly
// once, very early — if no listener exists yet it is lost). The event is
// then stashed in module scope so the UI component can call `prompt()`
// later when the user actually clicks "Install".
//
// We also listen for `appinstalled` to clear the stash and persist the
// "accepted" status so we never nag again.

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

type Listener = (event: BeforeInstallPromptEvent | null) => void;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(deferredPrompt);
    } catch {
      // ignore listener errors
    }
  }
}

export const INSTALL_STATE_KEY = 'openchat_install_prompt_state';
export const ENGAGEMENT_SESSIONS_KEY = 'openchat_engagement_sessions';
export const ENGAGEMENT_SECONDS_KEY = 'openchat_engagement_seconds';
export const ENGAGEMENT_LAST_SESSION_KEY = 'openchat_engagement_last_session';

export type InstallPromptStatus = 'pending' | 'accepted' | 'snoozed';

export interface InstallPromptState {
  status: InstallPromptStatus;
  dismissedUntil?: string; // ISO8601
}

export function readInstallState(): InstallPromptState {
  try {
    const raw = localStorage.getItem(INSTALL_STATE_KEY);
    if (!raw) return { status: 'pending' };
    const parsed = JSON.parse(raw) as InstallPromptState;
    if (parsed && (parsed.status === 'pending' || parsed.status === 'accepted' || parsed.status === 'snoozed')) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return { status: 'pending' };
}

export function writeInstallState(state: InstallPromptState): void {
  try {
    localStorage.setItem(INSTALL_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

export function snoozeInstallPrompt(days = 30): void {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  writeInstallState({ status: 'snoozed', dismissedUntil: until });
}

export function markInstallAccepted(): void {
  writeInstallState({ status: 'accepted' });
  deferredPrompt = null;
  notify();
}

export function isCurrentlySnoozed(): boolean {
  const state = readInstallState();
  if (state.status === 'accepted') return true; // installed → don't nag
  if (state.status === 'snoozed' && state.dismissedUntil) {
    return new Date(state.dismissedUntil).getTime() > Date.now();
  }
  return false;
}

export function isStandalone(): boolean {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    // ignore
  }
  // iOS Safari historic flag
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export function isIOSSafari(): boolean {
  const ua = window.navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  // Exclude Chrome/Firefox/Edge on iOS — they don't have the share-sheet
  // "Add to Home Screen" pathway either, so this detection is conservative.
  const isOtherBrowser = /CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && !isOtherBrowser;
}

export function getDeferredPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function subscribeDeferredPrompt(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function triggerInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = deferredPrompt;
  if (!evt) return 'unavailable';
  try {
    await evt.prompt();
    const result = await evt.userChoice;
    if (result.outcome === 'accepted') {
      markInstallAccepted();
      return 'accepted';
    }
    deferredPrompt = null;
    notify();
    return 'dismissed';
  } catch {
    deferredPrompt = null;
    notify();
    return 'dismissed';
  }
}

// Engagement tracking — incremented on app boot when a token exists,
// and tick-incremented (in seconds) while the window is focused.
//
// We use a sentinel `openchat_engagement_last_session` (timestamp of the
// last session boot) so reloads within ~5 minutes don't inflate the
// "session count". That makes "≥2 sessions" mean "≥2 distinct returns,
// not 2 quick reloads".
const SESSION_BUCKET_MS = 5 * 60 * 1000;

export function recordSessionStart(): void {
  try {
    const lastRaw = localStorage.getItem(ENGAGEMENT_LAST_SESSION_KEY);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    const now = Date.now();
    if (!last || now - last > SESSION_BUCKET_MS) {
      const sessions = (parseInt(localStorage.getItem(ENGAGEMENT_SESSIONS_KEY) || '0', 10) || 0) + 1;
      localStorage.setItem(ENGAGEMENT_SESSIONS_KEY, String(sessions));
    }
    localStorage.setItem(ENGAGEMENT_LAST_SESSION_KEY, String(now));
  } catch {
    // ignore
  }
}

export function recordEngagementTick(seconds: number): void {
  try {
    const cur = parseInt(localStorage.getItem(ENGAGEMENT_SECONDS_KEY) || '0', 10) || 0;
    localStorage.setItem(ENGAGEMENT_SECONDS_KEY, String(cur + seconds));
  } catch {
    // ignore
  }
}

export function getEngagement(): { sessions: number; seconds: number } {
  try {
    return {
      sessions: parseInt(localStorage.getItem(ENGAGEMENT_SESSIONS_KEY) || '0', 10) || 0,
      seconds: parseInt(localStorage.getItem(ENGAGEMENT_SECONDS_KEY) || '0', 10) || 0,
    };
  } catch {
    return { sessions: 0, seconds: 0 };
  }
}

let captureInitialized = false;

export function initInstallPromptCapture(): void {
  if (captureInitialized) return;
  captureInitialized = true;

  window.addEventListener('beforeinstallprompt', (event: Event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    markInstallAccepted();
  });
}
