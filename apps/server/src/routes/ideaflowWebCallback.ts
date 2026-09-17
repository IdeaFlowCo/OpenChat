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
 * Forward only OIDC response fields to the fixed RN-web entry point. The
 * provider marker prevents the existing Google callback handler in the client
 * from consuming the same standard `code` and `state` names.
 */
export function buildIdeaflowWebCallbackRedirect(query: Record<string, unknown>): string {
  const params = new URLSearchParams({ provider: 'ideaflow' });
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
