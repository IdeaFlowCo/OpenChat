/**
 * Link preview service (OpenChat-hq2).
 *
 * Fetches OG / Twitter card metadata for a URL, stores a :LinkPreview node
 * in Neo4j (deduplicated by URL, cached for 7 days), and links it to the
 * originating message via HAS_PREVIEW.
 *
 * Safety guardrails:
 *   - 5-second fetch timeout
 *   - 5 MB max content-length
 *   - non-HTML responses are ignored
 *   - localhost / private IP ranges are rejected (SSRF defence)
 */

import { load as cheerioLoad } from 'cheerio';
import { getDriver } from '../db.js';

export interface LinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
  fetchedAt: string;
}

// Private / loopback CIDR ranges we must not fetch (SSRF defence).
const PRIVATE_PREFIXES = [
  '10.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
  '127.',
  '169.254.',
  '::1',
  'fc00:', 'fd00:', 'fe80:',
];

function isPrivateHost(hostname: string): boolean {
  const lc = hostname.toLowerCase();
  if (lc === 'localhost') return true;
  for (const p of PRIVATE_PREFIXES) {
    if (lc.startsWith(p)) return true;
  }
  return false;
}

const CACHE_TTL_DAYS = 7;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Extract up to 2 URLs from a message body.
 */
export function extractUrls(content: string): string[] {
  const URL_RE = /https?:\/\/[^\s)\]'"<>]+/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(content)) !== null) {
    // Strip trailing punctuation that's likely not part of the URL
    let url = m[0].replace(/[.,!?:;]+$/, '');
    if (found.includes(url)) continue;
    found.push(url);
    if (found.length >= 2) break;
  }
  return found;
}

/**
 * Fetch OG metadata for a URL. Returns null on any failure (timeout, non-HTML,
 * private IP, oversized body, network error, etc.).
 */
async function fetchPreview(url: string): Promise<Omit<LinkPreview, 'fetchedAt'> | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (isPrivateHost(parsed.hostname)) {
    console.log(`[linkPreview] Skipping private host: ${parsed.hostname}`);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'OpenChat-LinkPreview/1.0 (+https://chat.globalbr.ai)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    clearTimeout(timer);

    if (!resp.ok) return null;

    const ct = resp.headers.get('content-type') || '';
    if (!ct.startsWith('text/html') && !ct.startsWith('application/xhtml')) {
      return null;
    }

    const cl = resp.headers.get('content-length');
    if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) return null;

    // Stream body up to MAX_BODY_BYTES
    const reader = resp.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.length + c.length);
        merged.set(acc);
        merged.set(c, acc.length);
        return merged;
      }, new Uint8Array(0))
    );

    const $ = cheerioLoad(html);

    const og = (prop: string) =>
      $(`meta[property="${prop}"]`).attr('content') ||
      $(`meta[property="${prop.toLowerCase()}"]`).attr('content') ||
      undefined;
    const twitter = (name: string) =>
      $(`meta[name="${name}"]`).attr('content') ||
      $(`meta[name="${name.toLowerCase()}"]`).attr('content') ||
      undefined;

    const title =
      og('og:title') ||
      twitter('twitter:title') ||
      $('title').first().text() ||
      null;

    const description =
      og('og:description') ||
      twitter('twitter:description') ||
      $('meta[name="description"]').attr('content') ||
      null;

    const image =
      og('og:image') ||
      twitter('twitter:image') ||
      twitter('twitter:image:src') ||
      null;

    const siteName =
      og('og:site_name') ||
      null;

    // Normalise relative image URLs
    let imageUrl: string | null = null;
    if (image) {
      try {
        imageUrl = new URL(image, url).href;
      } catch {
        imageUrl = null;
      }
    }

    // At least a title is required to surface a preview card
    const titleStr = title?.trim() || null;
    if (!titleStr) return null;

    return {
      url,
      title: titleStr,
      description: description?.trim() || null,
      image: imageUrl,
      siteName: siteName?.trim() || null,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[linkPreview] fetch error for ${url}: ${msg}`);
    return null;
  }
}

/**
 * Retrieve a cached preview from Neo4j if one exists and is < 7 days old.
 */
async function getCachedPreview(url: string): Promise<LinkPreview | null> {
  const session = getDriver().session();
  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = await session.run(`
      MATCH (p:LinkPreview {url: $url})
      WHERE p.fetchedAt > $cutoff
      RETURN p { .url, .title, .description, .image, .siteName, .fetchedAt } AS preview
    `, { url, cutoff });
    if (result.records.length === 0) return null;
    const raw = result.records[0].get('preview') as Record<string, unknown>;
    return {
      url: raw.url as string,
      title: (raw.title as string | null) ?? null,
      description: (raw.description as string | null) ?? null,
      image: (raw.image as string | null) ?? null,
      siteName: (raw.siteName as string | null) ?? null,
      fetchedAt: raw.fetchedAt as string,
    };
  } finally {
    await session.close();
  }
}

/**
 * Upsert a LinkPreview node and link it to a message.
 */
async function storePreview(messageId: string, preview: LinkPreview): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(`
      MERGE (p:LinkPreview {url: $url})
      SET p.title = $title,
          p.description = $description,
          p.image = $image,
          p.siteName = $siteName,
          p.fetchedAt = $fetchedAt
      WITH p
      MATCH (m:Message {id: $messageId})
      MERGE (m)-[:HAS_PREVIEW]->(p)
    `, {
      url: preview.url,
      title: preview.title ?? null,
      description: preview.description ?? null,
      image: preview.image ?? null,
      siteName: preview.siteName ?? null,
      fetchedAt: preview.fetchedAt,
      messageId,
    });
  } finally {
    await session.close();
  }
}

/**
 * Process link previews for a message asynchronously (fire-and-forget).
 * Emits `message:preview-ready` to the conversation room via Socket.IO when done.
 *
 * @param io       Socket.IO server instance
 * @param messageId  The message to attach previews to
 * @param conversationId  Used for room emission
 * @param content  Raw message text — scanned for URLs
 */
export function processLinkPreviews(
  io: import('socket.io').Server,
  messageId: string,
  conversationId: string,
  content: string
): void {
  const urls = extractUrls(content);
  if (urls.length === 0) return;

  // Run async, don't block the send path.
  void (async () => {
    for (const url of urls) {
      try {
        // Check cache first.
        let preview = await getCachedPreview(url);

        if (!preview) {
          const fetched = await fetchPreview(url);
          if (!fetched) continue; // failed fetch — skip silently
          preview = { ...fetched, fetchedAt: new Date().toISOString() };
          await storePreview(messageId, preview);
        } else {
          // Cached preview — still link it to this message.
          await storePreview(messageId, preview);
        }

        // Emit to the conversation room so all clients update.
        io.to(`conversation:${conversationId}`).emit('message:preview-ready', {
          messageId,
          preview,
        });
      } catch (err) {
        console.warn(`[linkPreview] error processing ${url}:`, err);
      }
    }
  })();
}

/**
 * Load link previews for a set of message IDs. Returns a map of
 * messageId → LinkPreview[].
 */
export async function loadPreviewsForMessages(
  messageIds: string[]
): Promise<Map<string, LinkPreview[]>> {
  const result = new Map<string, LinkPreview[]>();
  if (messageIds.length === 0) return result;

  const session = getDriver().session();
  try {
    const res = await session.run(`
      UNWIND $messageIds AS mid
      MATCH (m:Message {id: mid})-[:HAS_PREVIEW]->(p:LinkPreview)
      RETURN mid, p { .url, .title, .description, .image, .siteName, .fetchedAt } AS preview
    `, { messageIds });

    for (const rec of res.records) {
      const mid = rec.get('mid') as string;
      const preview = rec.get('preview') as Record<string, unknown>;
      if (!result.has(mid)) result.set(mid, []);
      result.get(mid)!.push({
        url: preview.url as string,
        title: (preview.title as string | null) ?? null,
        description: (preview.description as string | null) ?? null,
        image: (preview.image as string | null) ?? null,
        siteName: (preview.siteName as string | null) ?? null,
        fetchedAt: preview.fetchedAt as string,
      });
    }
  } finally {
    await session.close();
  }
  return result;
}
