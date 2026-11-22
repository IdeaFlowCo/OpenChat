// OpenChat product feedback uses WIT's screened intake and stable receipts.
import { randomUUID } from 'node:crypto';
import { getDriver } from '../db.js';
import { appBridgeConfigured } from './appSources.js';

const IDENTITY_ISSUER = 'https://id.ideaflow.app/api/auth';
const WIT_AUDIENCE = 'https://worldissuetracker.com';
// WIT moved to GCP on 2026-10-04; the Supabase project is frozen read-only.
export const witApiBase = (): string =>
  process.env.WIT_API_BASE || 'https://api.worldissuetracker.com/functions/v1';
// Same board as OpenChat web (#215) and native (#217) in-app feedback.
// The old 'openchat' board is being retired (world-issue-tracker-julr).
const delegationUrl = (): string =>
  process.env.IDEAFLOW_DELEGATION_URL || 'https://id.ideaflow.app/builtin-agent/delegated-token';

export const FEEDBACK_MAX_MESSAGE = 5000;
const FEEDBACK_RATE_LIMIT = 50; // per user per window
const FEEDBACK_WINDOW_MS = 60 * 60_000;
const feedbackRate = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const arr = (feedbackRate.get(userId) ?? []).filter((t) => t > now - FEEDBACK_WINDOW_MS);
  if (arr.length >= FEEDBACK_RATE_LIMIT) {
    feedbackRate.set(userId, arr);
    return true;
  }
  arr.push(now);
  feedbackRate.set(userId, arr);
  return false;
}

export type FeedbackSource = 'app' | 'assistant' | 'agent';
export type PostedAs = 'account' | 'connector' | 'anonymous';
export type FeedbackResult =
  | { ok: true; url?: string; receiptStatus?: string; id?: string; postedAs: PostedAs; displayName?: string; note?: string }
  | { ok: false; status: number; error: string };

type Filer = { name: string | null; issuer: string | null; subject: string | null };

async function loadFiler(userId: string): Promise<Filer> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      'MATCH (u:User {id:$userId}) RETURN u.name AS name, u.ideaflowIssuer AS issuer, u.ideaflowSub AS subject',
      { userId }
    );
    const row = result.records[0];
    const str = (key: string) => {
      const value = row?.get(key);
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    return { name: str('name'), issuer: str('issuer'), subject: str('subject') };
  } finally {
    await session.close();
  }
}

/** Short-lived, create-issue-only WIT token for this filer, or null. */
async function delegatedWitToken(filer: Filer): Promise<string | null> {
  if (filer.issuer !== IDENTITY_ISSUER || !filer.subject || !appBridgeConfigured()) return null;
  try {
    const response = await fetch(delegationUrl(), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          'Basic ' +
          Buffer.from(
            `${process.env.IDEAFLOW_BUILTIN_CLIENT_ID}:${process.env.IDEAFLOW_BUILTIN_CLIENT_SECRET}`
          ).toString('base64'),
      },
      body: JSON.stringify({
        issuer: filer.issuer,
        subject: filer.subject,
        audience: WIT_AUDIENCE,
        purpose: 'issue_create',
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
    return typeof data?.access_token === 'string' && data.access_token ? data.access_token : null;
  } catch {
    return null;
  }
}

export type WitWidgetToken = { token: string; expires_at: number };
const widgetTokens = new Map<string, WitWidgetToken>();

/**
 * Feedback token for the in-app WIT widget on web (menu-launched install,
 * WIT docs/widget-host-integration-guide.md#menu-launched-identity-verified-install).
 *
 * OpenChat keeps no Ideaflow ID token: sign-in verifies it and issues an
 * OpenChat JWT. Instead the server-side first-party delegation above mints a
 * short-lived WIT-audience token for the person, and WIT's feedback-token
 * endpoint exchanges that bearer for a `wfb1.` token that can only file
 * issues (no client-ID allowlist is involved on this path). Neither the
 * delegated token nor any Ideaflow token reaches the browser. Returns null
 * when the person has no Ideaflow identity or delegation is unavailable; the
 * widget then files anonymously.
 */
export async function witWidgetToken(userId: string): Promise<WitWidgetToken | null> {
  const cached = widgetTokens.get(userId);
  if (cached && cached.expires_at * 1000 - Date.now() > 120_000) return cached;
  widgetTokens.delete(userId);
  const bearer = await delegatedWitToken(await loadFiler(userId));
  if (!bearer) return null;
  try {
    const response = await fetch(`${witApiBase()}/feedback-token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ app: 'openchat' }),
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
    if (typeof data?.token !== 'string' || !data.token.startsWith('wfb1.') || !Number.isSafeInteger(data.expires_at)) return null;
    const result = { token: data.token, expires_at: data.expires_at as number };
    if (widgetTokens.size > 5000) widgetTokens.clear();
    widgetTokens.set(userId, result);
    return result;
  } catch {
    return null;
  }
}

export async function fileFeedback(params: {
  userId: string;
  message: string;
  context?: string;
  anonymous?: boolean;
  source: FeedbackSource;
  idempotencyKey?: string;
}): Promise<FeedbackResult> {
  const msg = params.message.trim().slice(0, FEEDBACK_MAX_MESSAGE);
  if (!msg) return { ok: false, status: 400, error: 'message is required' };
  if (rateLimited(params.userId)) {
    return { ok: false, status: 429, error: 'Feedback rate limit reached — please try again later.' };
  }
  const anonymous = params.anonymous === true;
  const filer = await loadFiler(params.userId);
  const token = anonymous ? null : (await witWidgetToken(params.userId))?.token;
  const key = anonymous || token ? null : process.env.WIT_AGENT_KEY;
  if (!anonymous && !token && !key) return { ok: false, status: 503, error: 'Feedback is not configured on the server.' };

  const postedAs: PostedAs = anonymous ? 'anonymous' : token ? 'account' : 'connector';
  const displayName = filer.name ?? 'An OpenChat user';
  const firstLine = msg.split('\n')[0]!.slice(0, 80);
  const body = {
    app: 'openchat', kind: 'other', title: firstLine || 'OpenChat feedback', details: msg,
    idempotency_key: params.idempotencyKey ?? randomUUID(),
  };

  try {
    const response = await fetch(`${witApiBase()}/product-feedback`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : key ? { 'X-Agent-Key': key } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null) as { intake_id?: string; status?: string; issue_url?: string } | null;
    if (!response.ok || !data?.intake_id || !data.status) {
      return { ok: false, status: response.status === 429 ? 429 : 502, error: 'Feedback receipt could not be confirmed' };
    }
    return {
      ok: true, url: data.issue_url, id: data.intake_id,
      receiptStatus: data.status, postedAs, ...(token ? { displayName } : {}),
    };
  } catch {
    return { ok: false, status: 502, error: 'Failed to reach feedback service' };
  }
}
