/**
 * Stream search over Vision: response decoding, unavailable-code
 * classification and merge ordering. Pure, so it is unit-testable without
 * React Native.
 *
 * Contract: GET /api/thoughts/vision-search?q&chip&cursor
 *   200 { status:'ok', rows, nextCursor }
 *   200 { status:'unavailable', code, reason }
 */

export type VisionChip = 'openchat' | 'all';

export interface VisionSearchRow {
  id: string;
  text: string;
  title: string | null;
  createdAt: string | null;
  url: string;
  sourcePlatform: string | null;
  sourceLink: string | null;
  tags: string[];
}

export type VisionUnavailableCode = 'account_link_required' | 'not_configured' | 'source_unavailable' | 'timeout';

export type VisionSearchResult =
  | { status: 'ok'; rows: VisionSearchRow[]; nextCursor: string | null }
  | { status: 'unavailable'; code: VisionUnavailableCode; reason: string };

export const VISION_SEARCH_DEBOUNCE_MS = 300;
/** Client backstop; the server enforces 2.5 s. */
export const VISION_SEARCH_TIMEOUT_MS = 3000;

export const VISION_UNAVAILABLE_NOTICE = 'Vision unavailable — showing OpenChat Stream only';

const UNAVAILABLE_CODES: readonly VisionUnavailableCode[] = ['account_link_required', 'not_configured', 'source_unavailable', 'timeout'];

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function decodeRow(raw: unknown): VisionSearchRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.text !== 'string' || typeof r.url !== 'string' || !r.url) return null;
  return {
    id: r.id,
    text: r.text,
    title: strOrNull(r.title),
    createdAt: typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : null,
    url: r.url,
    sourcePlatform: strOrNull(r.sourcePlatform),
    sourceLink: strOrNull(r.sourceLink),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

/**
 * Validate a vision-search payload. Anything that does not match the contract
 * decodes to `unavailable/source_unavailable` so callers fall back to local
 * search instead of rendering garbage.
 */
export function decodeVisionSearchResponse(payload: unknown): VisionSearchResult {
  const bad: VisionSearchResult = { status: 'unavailable', code: 'source_unavailable', reason: 'Unexpected Vision response' };
  if (!payload || typeof payload !== 'object') return bad;
  const p = payload as Record<string, unknown>;
  if (p.status === 'ok') {
    if (!Array.isArray(p.rows)) return bad;
    const rows = p.rows.map(decodeRow).filter((r): r is VisionSearchRow => r !== null);
    return { status: 'ok', rows, nextCursor: typeof p.nextCursor === 'string' && p.nextCursor ? p.nextCursor : null };
  }
  if (p.status === 'unavailable') {
    const code = UNAVAILABLE_CODES.find((c) => c === p.code) ?? 'source_unavailable';
    return { status: 'unavailable', code, reason: typeof p.reason === 'string' ? p.reason : '' };
  }
  return bad;
}

/**
 * `no_vision`: the user has no Vision; silently use local search and stop
 * calling Vision for the screen session. `degraded`: Vision is expected to
 * work but did not; fall back and show a notice.
 */
export function classifyUnavailable(code: VisionUnavailableCode): 'no_vision' | 'degraded' {
  return code === 'account_link_required' || code === 'not_configured' ? 'no_vision' : 'degraded';
}

// ── Merge ────────────────────────────────────────────────────────────────────

export type StreamItem<T = unknown> =
  | { source: 'local'; id: string; createdAt: string | null; thought: T }
  | { source: 'vision'; id: string; createdAt: string | null; row: VisionSearchRow };

function time(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Newest first; items without a usable createdAt go last (stable). */
export function sortByCreatedAtDesc<T extends { createdAt: string | null }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, t: time(item.createdAt) }))
    .sort((a, b) => (a.t === b.t ? a.index - b.index : a.t > b.t ? -1 : 1))
    .map((x) => x.item);
}

/**
 * Merge Vision rows and local thoughts for the "From OpenChat" chip. Vision
 * and local ids are namespaced so they never collide as list keys.
 */
export function mergeStreamItems<T extends { id: string; createdAt: string }>(
  vision: readonly VisionSearchRow[],
  local: readonly T[]
): StreamItem<T>[] {
  const items: StreamItem<T>[] = [
    ...vision.map((row): StreamItem<T> => ({ source: 'vision', id: `vision:${row.id}`, createdAt: row.createdAt, row })),
    ...local.map((thought): StreamItem<T> => ({ source: 'local', id: `local:${thought.id}`, createdAt: thought.createdAt, thought })),
  ];
  return sortByCreatedAtDesc(items);
}

/** Append a page, dropping rows already shown (cursor pages can overlap). */
export function appendVisionRows(existing: readonly VisionSearchRow[], page: readonly VisionSearchRow[]): VisionSearchRow[] {
  const seen = new Set(existing.map((r) => r.id));
  return [...existing, ...page.filter((r) => !seen.has(r.id))];
}

// ── Availability state ───────────────────────────────────────────────────────

/** unknown: not yet asked. available: a Vision call succeeded. none: no Vision for this user (stop asking). */
export type VisionAvailability = 'unknown' | 'available' | 'none';

export function nextAvailability(current: VisionAvailability, result: VisionSearchResult): VisionAvailability {
  if (result.status === 'ok') return 'available';
  return classifyUnavailable(result.code) === 'no_vision' ? 'none' : current;
}

/** Vision-supplied links are opened only when they are https. */
export function isOpenableVisionUrl(url: string): boolean {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}
