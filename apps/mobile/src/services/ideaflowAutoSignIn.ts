/**
 * Automatic cross-app sign-in on the OpenChat web app (code-xbh.21.1).
 *
 * A signed-out visitor who already has an Ideaflow ID session (from any other
 * Ideaflow app) is signed in without a click: once per browser session the web
 * app makes ONE top-level `prompt=none` round trip to id.ideaflow.app. With a
 * provider session the normal callback signs in and restores the original URL;
 * without one the provider answers `login_required` and the visitor is back on
 * the same URL, signed out, with no error.
 *
 * Never on native (iOS/Android keep their own system-browser flow), in embedded
 * webviews / in-app browsers, for crawlers, during prerender, inside frames,
 * after an explicit OpenChat sign-out, or when the server kill switch
 * (IDEAFLOW_AUTO_SIGNIN) is off.
 *
 * Kept free of react-native imports so the guards are unit-testable in Node.
 */

/** First-party session cookie (no expiry): one silent attempt per browser session, shared by tabs. */
export const AUTO_SIGNIN_COOKIE = 'ideaflow_auto_signin';

/**
 * Set on an explicit OpenChat sign-out; cleared once a session is established
 * again. While set, the app never signs anyone in silently.
 */
export const IDEAFLOW_SIGNED_OUT_KEY = 'openchat_ideaflow_signed_out';
/** The pre-existing "next sign-in asks which account" marker (ideaflowSignIn.ts). */
const ACCOUNT_CHOICE_KEY = 'openchat_ideaflow_choose_account';

/** Crawlers, link unfurlers and scripted clients (shared Ideaflow list). */
export const BOT_USER_AGENT =
  /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|quora link preview|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegram|discord|slack|skype|twitter|linkedin|preview|lighthouse|inspectiontool|ahrefs|semrush|mj12|yandex|baidu|duckduck|applebot|petalbot|bytespider|gptbot|claude|perplexity|ccbot|python|curl|wget|go-http|node-fetch|axios|okhttp|java\//i;

/** Embedded webviews, in-app browsers and desktop shells keep their own flows. */
export const EMBEDDED_USER_AGENT =
  /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|LinkedInApp|Snapchat|; wv\)|WebView|Electron|Tauri/;

/**
 * A bare WKWebView (the OpenChat desktop Tauri shell on macOS, iOS in-app
 * webviews) reports AppleWebKit without the `Safari/` token every real browser
 * on Apple platforms sends (Safari, Chrome, Firefox, Edge).
 */
export function isBareWebKitWebView(userAgent: string): boolean {
  return /AppleWebKit\//.test(userAgent) && !/Safari\//.test(userAgent);
}

/** Provider answers that only mean "no silent sign-in possible right now". */
export const SILENT_NO_SESSION_ERRORS = ['login_required', 'consent_required', 'interaction_required'] as const;

export interface AutoSignInEnvironment {
  /** react-native Platform.OS */
  platform: string;
  userAgent: string;
  /** document.cookie */
  cookie: string;
  cookieEnabled: boolean;
  /** document.prerendering, or a prefetch/prerender visibility state. */
  prerendering: boolean;
  /** window.top !== window */
  inFrame: boolean;
  /** A native shell bridge (ReactNativeWebView, Capacitor, Electron) is present. */
  nativeBridge: boolean;
  /** The query string the page was LOADED with (before any callback cleanup). */
  initialSearch: string;
  explicitlySignedOut: boolean;
}

export type AutoSignInBlock =
  | 'not-web'
  | 'callback'
  | 'already-attempted'
  | 'signed-out'
  | 'bot'
  | 'embedded'
  | 'prerender'
  | 'frame'
  | 'no-cookies';

/** True when the URL carries an OAuth/OIDC response (ours or Google's). */
export function isAuthCallbackSearch(search: string): boolean {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return false; }
  return params.has('provider') || params.has('code') || params.has('state') || params.has('error');
}

export function readCookie(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (key === name) return eq < 0 ? '' : part.slice(eq + 1).trim();
  }
  return null;
}

/** Returns why no automatic attempt may happen, or null when it may. */
export function autoSignInBlockReason(env: AutoSignInEnvironment): AutoSignInBlock | null {
  if (env.platform !== 'web') return 'not-web';
  if (env.nativeBridge || EMBEDDED_USER_AGENT.test(env.userAgent) || isBareWebKitWebView(env.userAgent)) {
    return 'embedded';
  }
  if (BOT_USER_AGENT.test(env.userAgent)) return 'bot';
  if (env.prerendering) return 'prerender';
  if (env.inFrame) return 'frame';
  if (!env.cookieEnabled) return 'no-cookies';
  if (isAuthCallbackSearch(env.initialSearch)) return 'callback';
  if (readCookie(env.cookie, AUTO_SIGNIN_COOKIE) !== null) return 'already-attempted';
  if (env.explicitlySignedOut) return 'signed-out';
  return null;
}

type BrowserGlobals = {
  window?: Window & typeof globalThis & Record<string, unknown>;
  document?: Document & { prerendering?: boolean };
  navigator?: Navigator;
};

function globals(): BrowserGlobals {
  const g = globalThis as unknown as BrowserGlobals;
  return {
    window: typeof window !== 'undefined' ? (window as BrowserGlobals['window']) : undefined,
    document: typeof document !== 'undefined' ? document as BrowserGlobals['document'] : g.document,
    navigator: typeof navigator !== 'undefined' ? navigator : g.navigator,
  };
}

function storageFlag(key: string): boolean {
  try {
    const store = typeof window !== 'undefined' ? window.localStorage : undefined;
    return store?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function hasNativeBridge(win: BrowserGlobals['window']): boolean {
  if (!win) return false;
  try {
    const w = win as unknown as Record<string, unknown> & {
      process?: { versions?: { electron?: unknown } };
      webkit?: { messageHandlers?: Record<string, unknown> };
    };
    return Boolean(
      w.ReactNativeWebView
      || w.__TAURI_INTERNALS__
      || w.__TAURI__
      || w.__TAURI_IPC__
      || w.Capacitor
      || w.electron
      || w.electronAPI
      || w.process?.versions?.electron
      || w.webkit?.messageHandlers?.openchat
      || w.webkit?.messageHandlers?.ReactNativeWebView,
    );
  } catch {
    return true;
  }
}

/** Reads the live browser. Anything unreadable blocks the attempt (fails closed). */
export function readBrowserEnvironment(platform: string, initialSearch: string): AutoSignInEnvironment {
  const { window: win, document: doc, navigator: nav } = globals();
  let inFrame = false;
  try { inFrame = !!win && win.top !== win.self; } catch { inFrame = true; }
  let cookie = '';
  try { cookie = doc?.cookie ?? ''; } catch { cookie = ''; }
  return {
    platform,
    userAgent: nav?.userAgent ?? '',
    cookie,
    cookieEnabled: !!doc && nav?.cookieEnabled !== false,
    prerendering: doc?.prerendering === true
      || (doc?.visibilityState as string | undefined) === 'prerender',
    inFrame,
    nativeBridge: hasNativeBridge(win),
    initialSearch,
    explicitlySignedOut: storageFlag(IDEAFLOW_SIGNED_OUT_KEY) || storageFlag(ACCOUNT_CHOICE_KEY),
  };
}

/**
 * Sets the once-per-browser-session marker before the redirect. Returns false
 * when the cookie does not stick (blocked cookies), so the caller does not
 * redirect; otherwise every load could bounce through the provider.
 */
export function markAutoSignInAttempted(doc: { cookie: string } | undefined = globals().document): boolean {
  if (!doc) return false;
  try {
    doc.cookie = `${AUTO_SIGNIN_COOKIE}=1; Path=/; Secure; SameSite=Lax`;
    return readCookie(doc.cookie, AUTO_SIGNIN_COOKIE) !== null;
  } catch {
    return false;
  }
}

export function markIdeaflowSignedOut(): void {
  try { window.localStorage.setItem(IDEAFLOW_SIGNED_OUT_KEY, '1'); } catch { /* storage blocked */ }
  // Also stop any automatic attempt for the rest of this browser session.
  markAutoSignInAttempted();
}

export function clearIdeaflowSignedOut(): void {
  try { window.localStorage.removeItem(IDEAFLOW_SIGNED_OUT_KEY); } catch { /* storage blocked */ }
}

const CALLBACK_PARAMS = ['provider', 'code', 'state', 'error', 'error_description', 'error_uri', 'iss', 'session_state'];

/** The current URL as a same-origin path + query + hash, minus any OAuth response fields. */
export function currentReturnPath(location: { pathname: string; search: string; hash: string }): string {
  const params = new URLSearchParams(location.search);
  for (const key of CALLBACK_PARAMS) params.delete(key);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`;
}

/**
 * Accepts only a same-origin relative path (no scheme, no `//host`, no
 * backslash tricks, no control characters). Anything else returns null and
 * the caller falls back to the app root.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const parsed = new URL(raw, 'https://openchat.invalid');
    if (parsed.origin !== 'https://openchat.invalid') return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export type IdeaflowWebCallbackAction =
  /** Not an Ideaflow callback. */
  | { kind: 'none' }
  /** Leave quietly: restore `returnTo`, stay signed out, show nothing. */
  | { kind: 'quiet'; returnTo: string | null }
  /** Show fixed error copy on the login page. */
  | { kind: 'error'; returnTo: string | null; stateMatched: boolean; error: string | null }
  | {
    kind: 'exchange';
    code: string;
    codeVerifier: string;
    nonce: string;
    silent: boolean;
    returnTo: string | null;
  };

/**
 * Decides what an Ideaflow web callback (`/app/?provider=ideaflow&...`) does.
 * The code is redeemed only when the returned state equals the one this tab
 * stored before leaving; a silent attempt never produces error UI.
 */
export function resolveIdeaflowWebCallback(search: string, storedRaw: string | null): IdeaflowWebCallbackAction {
  const params = new URLSearchParams(search);
  if (params.get('provider') !== 'ideaflow') return { kind: 'none' };
  const code = params.get('code');
  const error = params.get('error');
  const returnedState = params.get('state');

  let stored: {
    state?: unknown; nonce?: unknown; codeVerifier?: unknown; silent?: unknown; returnTo?: unknown;
  } | null = null;
  try { stored = storedRaw ? JSON.parse(storedRaw) : null; } catch { stored = null; }
  const validStored = !!stored
    && typeof stored.state === 'string'
    && typeof stored.nonce === 'string'
    && typeof stored.codeVerifier === 'string';
  const silent = validStored && stored!.silent === true;
  const returnTo = validStored ? safeReturnPath(stored!.returnTo) : null;

  if (!validStored || !returnedState || returnedState !== stored!.state) {
    // Our own silent attempt, or an unknown/stale response that only carries an
    // error: nothing to report, the visitor simply stays signed out.
    if (silent || (!validStored && error)) return { kind: 'quiet', returnTo };
    return { kind: 'error', returnTo, stateMatched: false, error };
  }
  if (error || !code) {
    if (silent) return { kind: 'quiet', returnTo };
    return { kind: 'error', returnTo, stateMatched: true, error };
  }
  return {
    kind: 'exchange',
    code,
    codeVerifier: stored!.codeVerifier as string,
    nonce: stored!.nonce as string,
    silent,
    returnTo,
  };
}
