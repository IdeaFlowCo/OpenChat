/**
 * Ideaflow ID web sign-in (OpenChat-3ag.12).
 *
 * "You sign in with Ideaflow": on web, when the server reports the Ideaflow ID
 * path enabled, the login screen offers only "Continue with Ideaflow". Legacy
 * methods stay reachable behind "Other sign-in options" so existing accounts
 * are never stranded. Native keeps its current methods until native Ideaflow
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
  /** The primary "Continue with Ideaflow" button. */
  ideaflow: boolean;
  /** "Use another Ideaflow account" (prompt=select_account). */
  switchAccount: boolean;
  /** The "Other sign-in options" disclosure link. */
  otherOptionsToggle: boolean;
  /** Google, email/password, create account, recovery help. */
  legacy: boolean;
  /** The old "Uses your Noos credentials" footer (native only now). */
  legacyFooter: boolean;
}

export function loginSurface(input: {
  isWeb: boolean;
  config: IdeaflowConfigState;
  showOtherOptions: boolean;
}): LoginSurface {
  if (!input.isWeb) {
    // Native is unchanged until native Ideaflow sign-in ships.
    return {
      pending: false,
      ideaflow: false,
      switchAccount: false,
      otherOptionsToggle: false,
      legacy: true,
      legacyFooter: true,
    };
  }
  if (input.config.status === 'loading') {
    return {
      pending: true,
      ideaflow: false,
      switchAccount: false,
      otherOptionsToggle: false,
      legacy: false,
      legacyFooter: false,
    };
  }
  if (!input.config.enabled) {
    // Server kill switch: fall back to the legacy methods without a rebuild.
    return {
      pending: false,
      ideaflow: false,
      switchAccount: false,
      otherOptionsToggle: false,
      legacy: true,
      legacyFooter: false,
    };
  }
  return {
    pending: false,
    ideaflow: true,
    switchAccount: true,
    otherOptionsToggle: true,
    legacy: input.showOtherOptions,
    legacyFooter: false,
  };
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
   * Only the explicit account-switch path sets this; ordinary sign-in sends no
   * prompt so an existing Ideaflow session signs in silently.
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
  if (!response.ok) throw new Error(`Could not start Ideaflow sign-in (${response.status})`);
  const body = await response.json() as { url?: string };
  if (!body.url) throw new Error('Ideaflow sign-in did not return an authorization URL');
  storage.setItem(IDEAFLOW_WEB_STATE_KEY, JSON.stringify({ state, nonce, codeVerifier }));
  return body.url;
}
