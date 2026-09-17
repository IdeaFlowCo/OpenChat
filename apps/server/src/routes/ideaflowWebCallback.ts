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
 * There is a single registered redirect_uri for both the unauthenticated
 * sign-in flow and the explicit authenticated-linking flow (see
 * docs/ideaflow-id-migration.md) — the client distinguishes them by prefixing
 * its opaque `state` value before starting the authorization request. This
 * constant must match IDEAFLOW_LINK_STATE_PREFIX in
 * apps/mobile/src/services/ideaflowLink.ts.
 */
const LINK_STATE_PREFIX = 'link.';

/**
 * Forward only OIDC response fields to the fixed RN-web entry point. The
 * provider marker prevents the existing Google callback handler in the client
 * from consuming the same standard `code` and `state` names, and further
 * distinguishes sign-in from explicit account linking so the client's
 * unauthenticated login screen never mistakes one redirect for the other.
 */
export function buildIdeaflowWebCallbackRedirect(query: Record<string, unknown>): string {
  const state = typeof query.state === 'string' ? query.state : '';
  const provider = state.startsWith(LINK_STATE_PREFIX) ? 'ideaflow-link' : 'ideaflow';
  const params = new URLSearchParams({ provider });
  for (const key of IDEAFLOW_CALLBACK_QUERY_KEYS) {
    const value = query[key];
    if (typeof value === 'string') params.set(key, value);
  }
  return `/app/?${params.toString()}`;
}

const router = Router();

router.get('/auth/ideaflow/callback', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, buildIdeaflowWebCallbackRedirect(req.query));
});

export default router;
