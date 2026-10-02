const CANONICAL_OPENCHAT_URL = 'https://chat.ideaflow.app';
const LEGACY_OPENCHAT_URL = 'https://chat.globalbr.ai';

// Native builds and non-production origins talk to the legacy host until the
// chat.ideaflow.app cutover lands (openchat-vul): that hostname still resolves
// to Vercel's wildcard and returns DEPLOYMENT_NOT_FOUND, so defaulting to it
// left native 1.0.4 unable to reach the server (OpenChat-p1yt). Flip this to
// CANONICAL_OPENCHAT_URL once the new host serves /api and WebSockets.
const DEFAULT_OPENCHAT_URL = LEGACY_OPENCHAT_URL;

export function resolveOpenChatUrl(override?: string, pageOrigin?: string): string {
  if (override) return override;
  if (pageOrigin === CANONICAL_OPENCHAT_URL || pageOrigin === LEGACY_OPENCHAT_URL) {
    return pageOrigin;
  }
  return DEFAULT_OPENCHAT_URL;
}
