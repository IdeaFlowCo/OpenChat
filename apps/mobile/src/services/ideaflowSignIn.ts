/**
 * Ideaflow ID web sign-in (OpenChat-3ag.12, code-xbh.3).
 *
 * On web, when the server reports the Ideaflow ID path enabled, the login
 * screen offers exactly one control: "Sign in with Ideaflow". Google,
 * email/password, sign-up and password reset all happen on id.ideaflow.app;
 * existing OpenChat accounts link server-side by verified email. The legacy
 * methods remain only as the kill-switch fallback (server flag off or
 * unreachable). Native keeps its current methods until native Ideaflow
 * sign-in ships separately.
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
  /** Web only: capability check still in flight — render no sign-in method yet. */
  pending: boolean;
  /** The single "Sign in with Ideaflow" button (plus its "New here?" hint). */
  ideaflow: boolean;
  /** Google, email/password, create account, recovery help. */
  legacy: boolean;
  /** The old "Uses your Noos credentials" footer (native only now). */
  legacyFooter: boolean;
}

export function loginSurface(input: {
  isWeb: boolean;
  config: IdeaflowConfigState;
}): LoginSurface {
  if (!input.isWeb) {
    // Native is unchanged until native Ideaflow sign-in ships.
    return { pending: false, ideaflow: false, legacy: true, legacyFooter: true };
  }
  if (input.config.status === 'loading') {
    return { pending: true, ideaflow: false, legacy: false, legacyFooter: false };
  }
  if (!input.config.enabled) {
    // Server kill switch (or unreachable): fall back to the legacy methods
    // without a rebuild.
    return { pending: false, ideaflow: false, legacy: true, legacyFooter: false };
  }
  return { pending: false, ideaflow: true, legacy: false, legacyFooter: false };
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

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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

/**
 * Generates state/nonce/PKCE, asks the server for the provider authorization
 * URL, and stores the verifier in same-tab session storage. Returns the URL
 * without navigating so callers can finish local work (e.g. sign out) first.
 */
export async function prepareIdeaflowWebSignIn(
  baseUrl: string,
  options: IdeaflowStartOptions = {},
  deps: { fetchImpl?: typeof fetch; storage?: Pick<Storage, 'setItem'> } = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const storage = deps.storage ?? globalThis.sessionStorage;
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await pkceChallenge(codeVerifier);
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
  storage.setItem(IDEAFLOW_WEB_STATE_KEY, JSON.stringify({ state, nonce, codeVerifier }));
  return body.url;
}
