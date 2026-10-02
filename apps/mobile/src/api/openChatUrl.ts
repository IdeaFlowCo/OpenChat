const CANONICAL_OPENCHAT_URL = 'https://chat.ideaflow.app';
const LEGACY_OPENCHAT_URL = 'https://chat.globalbr.ai';

// Native builds and non-production origins talk to the canonical host.
// chat.ideaflow.app serves /api, Socket.IO and the AASA file since the
// 2026-10-02 cutover (OpenChat-2a5g); OpenChat-p1yt had pinned the legacy host
// while it was still a Vercel 404. chat.globalbr.ai keeps serving indefinitely,
// and web pages keep talking to whichever production origin served them.
const DEFAULT_OPENCHAT_URL = CANONICAL_OPENCHAT_URL;

export function resolveOpenChatUrl(override?: string, pageOrigin?: string): string {
  if (override) return override;
  if (pageOrigin === CANONICAL_OPENCHAT_URL || pageOrigin === LEGACY_OPENCHAT_URL) {
    return pageOrigin;
  }
  return DEFAULT_OPENCHAT_URL;
}
