import { Router } from 'express';

const GOOGLE_CALLBACK_QUERY_KEYS = [
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
  'scope',
  'authuser',
  'prompt',
  'hd',
] as const;

/**
 * Build the fixed, same-origin handoff from Google's registered callback URL
 * to the React Native Web app. Only Google OAuth response parameters are
 * copied; caller-controlled navigation targets are deliberately ignored.
 */
export function buildGoogleWebCallbackRedirect(query: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const key of GOOGLE_CALLBACK_QUERY_KEYS) {
    const value = query[key];
    if (typeof value === 'string') params.set(key, value);
  }

  const serialized = params.toString();
  return serialized ? `/app/?${serialized}` : '/app/';
}

const router = Router();

router.get('/auth/google/callback', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, buildGoogleWebCallbackRedirect(req.query));
});

export default router;
