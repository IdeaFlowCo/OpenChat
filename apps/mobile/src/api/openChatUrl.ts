const DEFAULT_OPENCHAT_URL = 'https://chat.ideaflow.app';
const LEGACY_OPENCHAT_URL = 'https://chat.globalbr.ai';

export function resolveOpenChatUrl(override?: string, pageOrigin?: string): string {
  if (override) return override;
  if (pageOrigin === DEFAULT_OPENCHAT_URL || pageOrigin === LEGACY_OPENCHAT_URL) {
    return pageOrigin;
  }
  return DEFAULT_OPENCHAT_URL;
}
