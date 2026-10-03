/**
 * Ideaflow ID sign-in (OpenChat-3ag.12, code-xbh.3, code-xbh.14).
 *
 * When the server reports the Ideaflow ID path enabled, the login screen
 * offers one control: "Sign in with Ideaflow". Google, email/password,
 * sign-up and password reset all happen on id.ideaflow.app; existing OpenChat
 * accounts link server-side by verified email. The legacy methods remain only
 * as the kill-switch fallback (server flag off or unreachable).
 *
 * Web uses a full-page redirect. Native (iOS/Android) uses the system auth
 * session (ASWebAuthenticationSession / Custom Tabs) with the same server
 * endpoints: the state carries IDEAFLOW_NATIVE_STATE_PREFIX so the server's
 * https callback bounces the response to IDEAFLOW_NATIVE_REDIRECT_URI.
 *
 * Kept free of react-native imports so the decision logic and URL building are
 * unit-testable in plain Node.
 */

export const IDEAFLOW_WEB_STATE_KEY = 'openchat_ideaflow_web';

/** Hard ceiling on the capability check so a hung request never blanks login. */
export const IDEAFLOW_CONFIG_TIMEOUT_MS = 8000;

export type IdeaflowConfigState =
  | { status: 'loading' }
  | { status: 'ready'; enabled: boolean; passwordResetUrl: string | null };

export const IDEAFLOW_CONFIG_DISABLED: IdeaflowConfigState = {
  status: 'ready',
  enabled: false,
  passwordResetUrl: null,
};

export async function fetchIdeaflowConfig(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = IDEAFLOW_CONFIG_TIMEOUT_MS,
): Promise<IdeaflowConfigState> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(`${baseUrl}/api/auth/ideaflow/config`, {
      signal: controller?.signal,
    });
    if (!response.ok) return IDEAFLOW_CONFIG_DISABLED;
    const body = await response.json() as { enabled?: unknown; passwordResetUrl?: unknown };
    const enabled = body.enabled === true;
    return {
      status: 'ready',
      enabled,
      passwordResetUrl: enabled && typeof body.passwordResetUrl === 'string'
        ? body.passwordResetUrl
        : null,
    };
  } catch {
    // Unknown capability fails open to the legacy methods, never to a blank screen.
    return IDEAFLOW_CONFIG_DISABLED;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LoginSurface {
  /** Capability check still in flight — render no sign-in method yet. */
  pending: boolean;
  /** The single "Sign in with Ideaflow" button (plus its "New here?" hint). */
  ideaflow: boolean;
  /** Google, email/password, create account, recovery help. */
  legacy: boolean;
  /** The old "Uses your Noos credentials" footer (native kill-switch only). */
  legacyFooter: boolean;
  /**
   * iOS only: the native Sign in with Apple button. Kept beside the Ideaflow
   * button for existing Apple-only accounts until Ideaflow ID itself offers
   * Sign in with Apple (code-xbh.13); see KEEP_NATIVE_APPLE_SIGN_IN.
   */
  apple: boolean;
}

/**
 * Apple-only OpenChat accounts (often a private-relay email) cannot reach
 * their account through Ideaflow ID until it supports Sign in with Apple
 * (code-xbh.13). Until then the iOS login keeps the native Apple button next
 * to "Sign in with Ideaflow". Flip to false and publish an EAS update once
 * id.ideaflow.app offers Apple.
 */
export const KEEP_NATIVE_APPLE_SIGN_IN = true;

export function loginSurface(input: {
  /** react-native Platform.OS ('web' | 'ios' | 'android' | ...). */
  platform: string;
  config: IdeaflowConfigState;
  keepNativeApple?: boolean;
}): LoginSurface {
  const isWeb = input.platform === 'web';
  const isIos = input.platform === 'ios';
  const keepApple = input.keepNativeApple ?? KEEP_NATIVE_APPLE_SIGN_IN;
  if (input.config.status === 'loading') {
    return { pending: true, ideaflow: false, legacy: false, legacyFooter: false, apple: false };
  }
  if (!input.config.enabled) {
    // Server kill switch (or unreachable): fall back to the legacy methods
    // without a rebuild.
    return { pending: false, ideaflow: false, legacy: true, legacyFooter: !isWeb, apple: isIos };
  }
  return { pending: false, ideaflow: true, legacy: false, legacyFooter: false, apple: isIos && keepApple };
}

/**
 * Readable, fixed copy for an Ideaflow redirect that came back without a
 * usable code. Provider-supplied error text is never shown verbatim.
 */
export function ideaflowCallbackErrorMessage(input: {
  stateMatched: boolean;
  error: string | null;
}): string {
  if (!input.stateMatched) return 'That sign-in took too long or was interrupted. Please try again.';
  if (input.error === 'access_denied') return 'Sign-in was cancelled. You can try again.';
  return "Ideaflow sign-in didn't work. Please try again.";
}

// The Ideaflow provider session outlives an OpenChat sign-out, and without a
// prompt the provider would sign that same account straight back in. After an
// explicit sign-out (not a session expiry) the next sign-in sends
// prompt=select_account so the provider asks which account to use.
const ACCOUNT_CHOICE_KEY = 'openchat_ideaflow_choose_account';

function localStore(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function markIdeaflowAccountChoice(): void {
  try { localStore()?.setItem(ACCOUNT_CHOICE_KEY, '1'); } catch { /* storage blocked: next sign-in reuses the provider session */ }
}

/** Returns true once after an explicit sign-out, then clears the marker. */
export function takeIdeaflowAccountChoice(): boolean {
  const store = localStore();
  if (!store) return false;
  try {
    const marked = store.getItem(ACCOUNT_CHOICE_KEY) === '1';
    store.removeItem(ACCOUNT_CHOICE_KEY);
    return marked;
  } catch {
    return false;
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url without btoa, so it runs the same on web and Hermes. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64URL_ALPHABET[(triple >> 18) & 63] + BASE64URL_ALPHABET[(triple >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL_ALPHABET[(triple >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL_ALPHABET[triple & 63];
  }
  return out;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export interface IdeaflowStartOptions {
  /**
   * Ask Ideaflow ID to show its account chooser (OIDC prompt=select_account).
   * Only "Switch account" and the first sign-in after an explicit sign-out set
   * this; ordinary sign-in sends no prompt so an existing Ideaflow session
   * signs in silently.
   */
  selectAccount?: boolean;
}

export function ideaflowStartQuery(input: {
  state: string;
  nonce: string;
  codeChallenge: string;
} & IdeaflowStartOptions): URLSearchParams {
  const query = new URLSearchParams({
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
  });
  if (input.selectAccount) query.set('prompt', 'select_account');
  return query;
}

export interface IdeaflowPendingSignIn {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface IdeaflowPkceDeps {
  fetchImpl?: typeof fetch;
  /** base64url random string of `byteLength` random bytes. */
  random?: (byteLength: number) => string | Promise<string>;
  /** base64url(SHA-256(verifier)). */
  challenge?: (verifier: string) => Promise<string>;
}

/**
 * Generates state/nonce/PKCE and asks the server for the provider
 * authorization URL. Returns the URL and the secrets the caller must keep to
 * finish the exchange. `statePrefix` marks native flows for the server's
 * callback bounce.
 */
export async function startIdeaflowSignIn(
  baseUrl: string,
  options: IdeaflowStartOptions & { statePrefix?: string } = {},
  deps: IdeaflowPkceDeps = {},
): Promise<{ url: string; pending: IdeaflowPendingSignIn }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const random = deps.random ?? randomBase64Url;
  const challenge = deps.challenge ?? pkceChallenge;
  const state = `${options.statePrefix ?? ''}${await random(32)}`;
  const nonce = await random(32);
  const codeVerifier = await random(48);
  const codeChallenge = await challenge(codeVerifier);
  const query = ideaflowStartQuery({
    state,
    nonce,
    codeChallenge,
    selectAccount: options.selectAccount === true,
  });
  const response = await fetchImpl(`${baseUrl}/api/auth/ideaflow/url?${query}`);
  if (!response.ok) throw new Error("Couldn't reach Ideaflow. Please try again in a moment.");
  const body = await response.json() as { url?: string };
  if (!body.url) throw new Error("Couldn't reach Ideaflow. Please try again in a moment.");
  return { url: body.url, pending: { state, nonce, codeVerifier } };
}

/**
 * Web: starts sign-in and stores the verifier in same-tab session storage.
 * Returns the URL without navigating so callers can finish local work (e.g.
 * sign out) first.
 */
export async function prepareIdeaflowWebSignIn(
  baseUrl: string,
  options: IdeaflowStartOptions = {},
  deps: { fetchImpl?: typeof fetch; storage?: Pick<Storage, 'setItem'> } = {},
): Promise<string> {
  const storage = deps.storage ?? globalThis.sessionStorage;
  const { url, pending } = await startIdeaflowSignIn(baseUrl, options, { fetchImpl: deps.fetchImpl });
  storage.setItem(IDEAFLOW_WEB_STATE_KEY, JSON.stringify(pending));
  return url;
}

// ── Native (code-xbh.14) ────────────────────────────────────────────────────

/** Must match apps/server/src/routes/ideaflowWebCallback.ts. */
export const IDEAFLOW_NATIVE_STATE_PREFIX = 'native-';
/** The app's own scheme (app.config.js `scheme: 'openchat'`). */
export const IDEAFLOW_NATIVE_REDIRECT_URI = 'openchat://auth/ideaflow/callback';

export type IdeaflowNativeCallback =
  | { kind: 'code'; code: string }
  | { kind: 'error'; message: string };

/**
 * Reads the URL the system auth session returned. Only a callback carrying
 * the exact state this app generated is accepted; provider text is never
 * shown verbatim.
 */
export function parseIdeaflowNativeCallback(
  returnedUrl: string,
  expectedState: string,
): IdeaflowNativeCallback {
  let params: URLSearchParams;
  try {
    const queryStart = returnedUrl.indexOf('?');
    if (!returnedUrl.startsWith(IDEAFLOW_NATIVE_REDIRECT_URI) || queryStart < 0) {
      throw new Error('unexpected callback');
    }
    params = new URLSearchParams(returnedUrl.slice(queryStart + 1).split('#')[0]);
  } catch {
    return { kind: 'error', message: ideaflowCallbackErrorMessage({ stateMatched: false, error: null }) };
  }
  const state = params.get('state');
  const error = params.get('error');
  if (!state || state !== expectedState) {
    return { kind: 'error', message: ideaflowCallbackErrorMessage({ stateMatched: false, error }) };
  }
  const code = params.get('code');
  if (error || !code) {
    return { kind: 'error', message: ideaflowCallbackErrorMessage({ stateMatched: true, error }) };
  }
  return { kind: 'code', code };
}

/** Standard base64 (as returned by expo-crypto) to unpadded base64url. */
export function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
