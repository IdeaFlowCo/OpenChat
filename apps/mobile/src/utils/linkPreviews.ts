import type { LinkPreview } from '../api/client';

/** Same page modulo scheme, www., trailing slash and #fragment. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return url; }
}

/**
 * One card per page (OpenChat-eo3n.5): agents often repeat a link, or give it
 * with and without www., and the message showed identical cards stacked.
 * Cards with the same title on the same host are also the same card.
 */
export function dedupeLinkPreviews(previews: LinkPreview[]): LinkPreview[] {
  const seen = new Set<string>();
  return previews.filter(preview => {
    const keys = [pageKey(preview.url)];
    // Same title on the same host is the same card; different hosts never collapse.
    if (preview.title) keys.push(`title:${hostOf(preview.url)}|${preview.title.trim().toLowerCase()}`);
    if (keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  });
}
