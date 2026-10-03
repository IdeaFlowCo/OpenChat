import { Router } from 'express';

const IDEAFLOW_CALLBACK_QUERY_KEYS = [
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
  'iss',
] as const;

/**
 * Native (iOS/Android) sign-in marks its OIDC `state` with this prefix
 * (code-xbh.14). The provider only knows the registered https callback, so the
 * server bounces the response to the app's fixed custom-scheme URL, which the
 * system auth session (ASWebAuthenticationSession / Custom Tabs) is waiting
 * for. The code is useless without the PKCE verifier that never leaves the
 * app, and the app accepts only a state it generated itself.
 */
export const IDEAFLOW_NATIVE_STATE_PREFIX = 'native-';
export const IDEAFLOW_NATIVE_REDIRECT_URI = 'openchat://auth/ideaflow/callback';

/**
 * Forward only OIDC response fields to a fixed destination: the RN-web entry
 * point, or the native app's callback when the state carries the native
 * marker. The provider marker prevents the existing Google callback handler in
 * the web client from consuming the same standard `code` and `state` names.
 */
export function buildIdeaflowWebCallbackRedirect(query: Record<string, unknown>): string {
  const params = new URLSearchParams({ provider: 'ideaflow' });
  for (const key of IDEAFLOW_CALLBACK_QUERY_KEYS) {
    const value = query[key];
    if (typeof value === 'string') params.set(key, value);
  }
  const state = query.state;
  if (typeof state === 'string' && state.startsWith(IDEAFLOW_NATIVE_STATE_PREFIX)) {
    return `${IDEAFLOW_NATIVE_REDIRECT_URI}?${params.toString()}`;
  }
  return `/app/?${params.toString()}`;
}

const router = Router();

router.get('/auth/ideaflow/callback', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, buildIdeaflowWebCallbackRedirect(req.query));
});

export default router;
