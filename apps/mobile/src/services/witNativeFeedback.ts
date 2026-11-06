/**
 * Native (iOS/Android) in-app feedback → World Issue Tracker, per the native
 * contract in WIT docs/widget-host-integration-guide.md §6 (julr.11).
 *
 * The web build uses the WIT widget (services/witWidget.ts). Native has no
 * widget, so FeedbackModal posts directly to WIT:
 *   1. POST /api/feedback/wit-token on OpenChat's own server (existing
 *      session) → a 15-minute, create-issue-only `wfb1.` token. No Ideaflow
 *      token ever reaches the device for this.
 *   2. POST {WIT}/create-issue with `Authorization: Bearer wfb1.…` and
 *      `X-WIT-Client: ios|android`. WIT derives sender_trust from the token;
 *      the app never claims a reporter identity.
 *   3. Optional screenshot: create-attachment-upload → signed PUT →
 *      finalize-attachment-upload with the same bearer.
 * Any token failure (none, exchange error, 401) files anonymously instead of
 * losing the report.
 */

export const WIT_API_BASE = 'https://api.worldissuetracker.com/functions/v1';
export const WIT_NATIVE_FEEDBACK_TRACKER = 'openchat-feedback';

export type WitFeedbackTokenResponse = { token: string | null; expires_at?: number };
type TokenFetcher = () => Promise<WitFeedbackTokenResponse>;

export interface FeedbackContext {
  app: string;
  version: string;
  build?: string | null;
  /** Screen name or deep link the person was on. */
  source: string;
  /** e.g. "iPhone 15 Pro, iOS 18.1" */
  device: string;
  platform: 'ios' | 'android' | 'web' | string;
}

export interface FeedbackScreenshot {
  uri: string;
  mimeType: string;
  fileName: string;
}

export interface SubmitResult {
  issueUrl: string | null;
  /** True when WIT accepted the verified sender token. */
  verified: boolean;
  /** Set when the issue was filed but the screenshot could not be attached. */
  attachmentError?: string;
}

export class FeedbackSubmitError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'FeedbackSubmitError';
  }
}

let tokenFetcher: TokenFetcher | null = null;
let cached: WitFeedbackTokenResponse | null = null;

/** Signed in: register the token source. Signed out: null (next report is anonymous). */
export function setNativeFeedbackUser(fetchToken: TokenFetcher | null): void {
  tokenFetcher = fetchToken;
  cached = null;
}

/** The cached `wfb1.` token (refreshed a minute before expiry), or null. */
export async function currentFeedbackToken(now: () => number = Date.now): Promise<string | null> {
  if (!tokenFetcher) return null;
  if (cached?.token && (cached.expires_at ?? 0) * 1000 - now() > 60_000) return cached.token;
  try {
    const next = await tokenFetcher();
    cached = next?.token && next.token.startsWith('wfb1.') ? next : null;
  } catch {
    cached = null;
  }
  return cached?.token ?? null;
}

export function contextFooter(ctx: FeedbackContext): string {
  const build = ctx.build ? ` (${ctx.build})` : '';
  return `App: ${ctx.app} v${ctx.version}${build}\nSource: ${ctx.source}\nDevice: ${ctx.device}`;
}

/** First line of the message, trimmed to a readable issue title. */
export function titleFromMessage(message: string): string {
  const first = message.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (first.length <= 80) return first || 'Feedback';
  const cut = first.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function headers(platform: string, bearer: string | null, json = true): Record<string, string> {
  const out: Record<string, string> = { 'X-WIT-Client': platform === 'android' ? 'android' : 'ios' };
  if (json) out['Content-Type'] = 'application/json';
  if (bearer) out.Authorization = `Bearer ${bearer}`;
  return out;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

function retryAfter(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function uploadScreenshot(
  doFetch: typeof fetch,
  issueId: string,
  shot: FeedbackScreenshot,
  bearer: string | null,
  platform: string,
): Promise<void> {
  const blob = await (await doFetch(shot.uri)).blob();
  const descriptor = {
    issue_id: issueId,
    file_name: shot.fileName || 'screenshot.jpg',
    mime_type: (shot.mimeType || blob.type || 'image/jpeg').toLowerCase(),
    byte_size: blob.size,
  };
  const post = async (path: string, body: object) => {
    const res = await doFetch(`${WIT_API_BASE}/${path}`, {
      method: 'POST',
      headers: headers(platform, bearer),
      body: JSON.stringify(body),
    });
    const parsed = await readJson(res);
    if (!res.ok || parsed.error) throw new Error(String(parsed.message || parsed.error || `HTTP ${res.status}`));
    return parsed;
  };
  const upload = (await post('create-attachment-upload', descriptor)) as {
    upload_url?: string; method?: string; headers?: Record<string, string>; storage_path?: string;
  };
  if (!upload.upload_url || !upload.storage_path) throw new Error('No upload URL returned');
  // Signed URL: exactly the signed headers, never a WIT credential.
  const put = await doFetch(upload.upload_url, {
    method: upload.method || 'PUT',
    headers: upload.headers || { 'Content-Type': descriptor.mime_type },
    body: blob,
  });
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
  await post('finalize-attachment-upload', { ...descriptor, storage_path: upload.storage_path });
}

export async function submitNativeFeedback(
  input: { message: string; anonymous: boolean; screenshot?: FeedbackScreenshot | null; context: FeedbackContext },
  opts: { fetch?: typeof fetch; tracker?: string } = {},
): Promise<SubmitResult> {
  const doFetch = opts.fetch ?? fetch;
  const tracker = opts.tracker ?? WIT_NATIVE_FEEDBACK_TRACKER;
  const message = input.message.trim();
  if (!message) throw new FeedbackSubmitError('Write something first.');
  const title = titleFromMessage(message);
  const payload = {
    tracker_slug: tracker,
    title,
    description: `${message}\n\n${contextFooter(input.context)}`,
    original_text: message,
    issue_type: 'bug',
  };
  const send = (bearer: string | null) => doFetch(`${WIT_API_BASE}/create-issue`, {
    method: 'POST',
    headers: headers(input.context.platform, bearer),
    body: JSON.stringify(payload),
  });

  let bearer = input.anonymous ? null : await currentFeedbackToken();
  let res: Response;
  try {
    res = await send(bearer);
    // A stale/rejected sender token must never lose the report.
    if (bearer && res.status === 401) {
      cached = null;
      bearer = null;
      res = await send(null);
    }
  } catch {
    throw new FeedbackSubmitError('You appear to be offline. Your message is still here; try again when you’re connected.');
  }
  const body = await readJson(res);
  if (res.status === 429) {
    const wait = retryAfter(res);
    throw new FeedbackSubmitError(
      `Too many reports just now. Try again in ${wait !== undefined ? `${Math.max(1, Math.ceil(wait))} s` : 'a moment'}.`,
      429,
      wait,
    );
  }
  if (!res.ok || body.error) {
    throw new FeedbackSubmitError(String(body.message || body.error || `Couldn’t send feedback (HTTP ${res.status}).`), res.status);
  }
  const issue = (body.issue ?? {}) as { id?: string; slug?: string; tracker_slug?: string };
  const routeId = issue.slug || issue.id;
  const result: SubmitResult = {
    issueUrl: routeId ? `https://${issue.tracker_slug || tracker}.worldissuetracker.com/issue/${encodeURIComponent(routeId)}` : null,
    verified: Boolean(bearer),
  };
  if (input.screenshot && issue.id) {
    try {
      await uploadScreenshot(doFetch, issue.id, input.screenshot, bearer, input.context.platform);
    } catch (err) {
      result.attachmentError = err instanceof Error ? err.message : 'Screenshot upload failed';
    }
  }
  return result;
}
