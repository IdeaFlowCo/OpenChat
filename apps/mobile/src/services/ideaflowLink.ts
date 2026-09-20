/**
 * Explicit, authenticated Ideaflow ID account linking (Settings screen).
 *
 * Reuses the same state/nonce/PKCE machinery as the unauthenticated sign-in
 * flow in LoginScreen (see ../utils/pkce.ts), but hits the authenticated
 * /ideaflow/link/* endpoints and is started from an already-signed-in
 * screen. The redirect back from Ideaflow ID is a full page load, so
 * completion is driven from App.tsx (always mounted) rather than from
 * SettingsScreen, which may have unmounted by the time the browser returns.
 * The server also records the initiating user, exact JWT session, nonce, and
 * PKCE challenge under this state; the callback must match all of them.
 */
import { ideaflowLinkExchange, ideaflowLinkUrl } from '../api/client';
import { pkceChallenge, randomBase64Url } from '../utils/pkce';

const LINK_STATE_KEY = 'openchat_ideaflow_link_web';
export const IDEAFLOW_LINK_PROVIDER_MARKER = 'ideaflow-link';

/**
 * There is one registered OIDC redirect_uri shared by sign-in and explicit
 * linking. Prefixing `state` lets the server's callback route tell them apart
 * without a second client registration. Must match LINK_STATE_PREFIX in
 * apps/server/src/routes/ideaflowWebCallback.ts.
 */
const LINK_STATE_PREFIX = 'link.';

export async function startIdeaflowLink(): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('Ideaflow ID linking is only available on web right now');
  }

  const state = `${LINK_STATE_PREFIX}${randomBase64Url(32)}`;
  const nonce = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await pkceChallenge(codeVerifier);

  const url = await ideaflowLinkUrl({ state, nonce, codeChallenge });

  window.sessionStorage.setItem(LINK_STATE_KEY, JSON.stringify({ state, nonce, codeVerifier }));
  window.location.href = url;
}

export interface IdeaflowLinkRedirectResult {
  /** False when the current URL isn't an Ideaflow-ID-linking redirect at all. */
  handled: boolean;
  success?: boolean;
  message?: string;
  ideaflowEmail?: string | null;
}

/**
 * Call on every app load, from a component that stays mounted regardless of
 * auth state. No-ops unless the URL carries our linking provider marker.
 */
export async function completeIdeaflowLinkFromLocation(): Promise<IdeaflowLinkRedirectResult> {
  if (typeof window === 'undefined') return { handled: false };

  const params = new URLSearchParams(window.location.search);
  if (params.get('provider') !== IDEAFLOW_LINK_PROVIDER_MARKER) return { handled: false };

  const code = params.get('code');
  const oauthError = params.get('error');
  const returnedState = params.get('state');
  const basePath = `/${window.location.pathname.split('/')[1] || ''}/`;
  window.history.replaceState({}, '', basePath);

  let stored: { state: string; nonce: string; codeVerifier: string } | null = null;
  try {
    const raw = window.sessionStorage.getItem(LINK_STATE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  window.sessionStorage.removeItem(LINK_STATE_KEY);

  if (!stored || !returnedState || returnedState !== stored.state) {
    return { handled: true, success: false, message: 'Session expired or state mismatch — please try again.' };
  }
  if (oauthError || !code) {
    return {
      handled: true,
      success: false,
      message: params.get('error_description') || oauthError || 'No authorization code was returned.',
    };
  }

  try {
    const result = await ideaflowLinkExchange(
      code,
      stored.codeVerifier,
      stored.nonce,
      stored.state,
    );
    return { handled: true, success: true, ideaflowEmail: result.ideaflowEmail };
  } catch (err) {
    return { handled: true, success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
