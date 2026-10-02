// External actions for the in-app Assistant (OpenChat-1fwa):
//  - World Issue Tracker (worldissuetracker.com) — search/read/create/update
//  - unlinked.ai — account-scoped network/people search
//
// SECURITY MODEL (OpenChat is multi-user — read before editing):
//  - "As Jacob" (owner-credentialed) paths are gated server-side on the
//    OpenChat user id of the invoking user, via OPENCHAT_OWNER_USER_ID.
//    The id comes from the server's own trusted auth context (JWT /
//    agent-key resolution), NEVER from model input or message text.
//  - Strict `===` comparison only. Empty/unset env = nobody is owner.
//  - All credentials (WIT agent key, unlinked account token) live in
//    server env on the deployment host. They are never included in tool
//    results, prompts, or error messages.
//  - Every other user gets the anonymous path where the remote service
//    itself permits anonymous access (WIT reads + anonymous issue/comment/
//    tracker create), or a clean refusal (unlinked, WIT updates). An owner
//    call that WIT rejects is reported as an error — it is never retried
//    anonymously, so owner-intended writes cannot silently lose attribution.

// ─── Identity gate ────────────────────────────────────────────────────────────

/**
 * True only when `userId` is the configured owner (Jacob's OpenChat user id).
 * `userId` MUST be the server-trusted id passed into executeTool — it is set
 * from the authenticated socket/REST actor, not from anything the model says.
 */
export function isOwnerUser(userId: string): boolean {
  const owner = (process.env.OPENCHAT_OWNER_USER_ID || '').trim();
  if (owner.length === 0) return false;
  if (typeof userId !== 'string' || userId.length === 0) return false;
  return userId === owner; // strict equality — never includes()/startsWith()
}

// ─── Shared write rate limiter (per user) ────────────────────────────────────

const WRITE_RATE_LIMIT = 30; // external writes per user per hour
const WRITE_WINDOW_MS = 60 * 60_000;
const writeRate = new Map<string, number[]>();

function writeRateLimited(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - WRITE_WINDOW_MS;
  const arr = (writeRate.get(userId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= WRITE_RATE_LIMIT) {
    writeRate.set(userId, arr);
    return true;
  }
  arr.push(now);
  writeRate.set(userId, arr);
  return false;
}

// ─── World Issue Tracker ─────────────────────────────────────────────────────
// API docs: https://worldissuetracker.com/llms.txt
// Reads + anonymous issue/comment/tracker creation need only the public anon
// JWT (`apikey` header). Owner-attributed writes (update, owned trackers) need
// the owner agent key: apikey + `Authorization: Bearer <anon>` + `X-Agent-Key`.
// Anonymous trackers are public, listed, ownerless, and rate-limited by WIT
// (world-issue-tracker-wkn4); WIT refuses exact duplicates with 409.

const WIT_BASE =
  process.env.WIT_API_BASE || 'https://qmzopiburflputowkuhu.supabase.co/functions/v1';
const WIT_SITE = process.env.WIT_SITE_URL || 'https://worldissuetracker.com';
const WIT_TIMEOUT_MS = 15_000;

function witAnonKey(): string {
  return (process.env.WIT_ANON_KEY || '').trim();
}

function witAgentKey(): string {
  return (process.env.WIT_AGENT_KEY || '').trim();
}

type WitMode = 'owner' | 'anonymous';

/**
 * Resolve how this call will authenticate to WIT.
 *  - owner: invoking user is the configured owner AND they did not ask for
 *    anonymity AND the agent key is configured.
 *  - anonymous: everyone else, and the owner when `anonymous: true`.
 */
function witMode(userId: string, anonymous: boolean): WitMode {
  if (!anonymous && isOwnerUser(userId) && witAgentKey().length > 0) return 'owner';
  return 'anonymous';
}

export function resolveWitTrackerCreationMode(
  userId: string,
  anonymous: boolean
): { mode: WitMode } | { error: string } {
  if (!anonymous && isOwnerUser(userId)) {
    if (!witAgentKey()) {
      return { error: 'Owner tracker creation is not configured on the server; ask to create it anonymously instead.' };
    }
    return { mode: 'owner' };
  }
  return { mode: 'anonymous' };
}

function witHeaders(mode: WitMode): Record<string, string> {
  const anon = witAnonKey();
  // X-WIT-Client is informational provenance only (WIT creation_surface).
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-WIT-Client': 'openchat' };
  if (anon) headers['apikey'] = anon;
  if (mode === 'owner') {
    if (anon) headers['Authorization'] = `Bearer ${anon}`;
    headers['X-Agent-Key'] = witAgentKey();
  }
  return headers;
}

async function witFetch(
  path: string,
  mode: WitMode,
  init?: { method?: string; body?: unknown }
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!witAnonKey()) {
    // Without the anon apikey the Edge Functions reject everything.
    return { ok: false, status: 0, data: { error: 'Issue tracker is not configured on the server.' } };
  }
  const r = await fetch(`${WIT_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: witHeaders(mode),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(WIT_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

function issueUrl(slug?: string | null): string {
  return slug ? `${WIT_SITE}/issue/${slug}` : WIT_SITE;
}

/** Trim an issue row to what the model needs (keeps tool results small). */
function compactIssue(i: any): Record<string, unknown> {
  if (!i || typeof i !== 'object') return i;
  return {
    id: i.id,
    slug: i.slug,
    title: i.title,
    status: i.status,
    priority: i.priority,
    category: i.category,
    issue_type: i.issue_type,
    tracker_slug: i.tracker_slug,
    labels: i.labels,
    reporter: i.reporter,
    created_at: i.created_at,
    updated_at: i.updated_at,
    description:
      typeof i.description === 'string' && i.description.length > 1500
        ? `${i.description.slice(0, 1500)}…`
        : i.description,
    url: i.url || issueUrl(i.slug),
  };
}

export async function toolWitListTrackers(query?: string, limit = 20): Promise<unknown> {
  // When text-filtering client-side, fetch the max page so the filter sees
  // the whole catalog (verified live: 126 trackers; a 20-row page missed
  // the 'openchat' board).
  const fetchLimit = query?.trim() ? 100 : Math.min(Math.max(limit, 1), 100);
  const res = await witFetch(`/get-trackers?limit=${fetchLimit}`, 'anonymous');
  if (!res.ok) return { error: 'Failed to list trackers' };
  let trackers: any[] = Array.isArray(res.data?.trackers) ? res.data.trackers : [];
  const q = query?.trim().toLowerCase();
  if (q) {
    trackers = trackers.filter(
      (t) =>
        String(t.name ?? '').toLowerCase().includes(q) ||
        String(t.slug ?? '').toLowerCase().includes(q) ||
        String(t.description ?? '').toLowerCase().includes(q)
    );
  }
  return {
    trackers: trackers.map((t) => ({
      slug: t.slug,
      name: t.name,
      description:
        typeof t.description === 'string' && t.description.length > 300
          ? `${t.description.slice(0, 300)}…`
          : t.description,
      open_issue_count: t.open_issue_count,
      url: `${WIT_SITE}/tracker/${t.slug}`,
    })),
    total_count: res.data?.total_count,
  };
}

export async function toolWitListIssues(params: {
  trackerSlug?: string;
  status?: string;
  label?: string;
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<unknown> {
  const qs = new URLSearchParams();
  if (params.trackerSlug) qs.set('tracker_slug', params.trackerSlug);
  if (params.status) qs.set('status', params.status);
  if (params.label) qs.set('label', params.label);
  // When text-filtering client-side, fetch a bigger page to filter from.
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  qs.set('limit', String(params.query ? 100 : limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const res = await witFetch(`/get-issues?${qs.toString()}`, 'anonymous');
  if (!res.ok) return { error: 'Failed to list issues', detail: res.data?.message };
  let issues: any[] = Array.isArray(res.data?.issues) ? res.data.issues : [];
  const q = params.query?.trim().toLowerCase();
  if (q) {
    issues = issues
      .filter(
        (i) =>
          String(i.title ?? '').toLowerCase().includes(q) ||
          String(i.description ?? '').toLowerCase().includes(q)
      )
      .slice(0, limit);
  }
  return { issues: issues.map(compactIssue), total_count: res.data?.total_count };
}

export async function toolWitGetIssue(idOrSlug: string): Promise<unknown> {
  const res = await witFetch(`/get-issues?id=${encodeURIComponent(idOrSlug)}`, 'anonymous');
  if (!res.ok) return { error: 'Failed to fetch issue', detail: res.data?.message };
  const issue = Array.isArray(res.data?.issues) ? res.data.issues[0] : undefined;
  if (!issue) return { error: 'Issue not found' };
  let comments: unknown[] = [];
  if (issue.id) {
    const c = await witFetch(`/get-comments?issue_id=${encodeURIComponent(issue.id)}&limit=50`, 'anonymous');
    if (c.ok && Array.isArray(c.data?.comments)) {
      comments = c.data.comments.map((cm: any) => ({
        author_name: cm.author_name,
        content: cm.content,
        created_at: cm.created_at,
      }));
    }
  }
  return { issue: { ...compactIssue(issue), description: issue.description }, comments };
}

const OWNER_REPORTER = process.env.WIT_OWNER_REPORTER || 'Jacob Cole (via OpenChat Assistant)';

export async function toolWitCreateIssue(
  userId: string,
  params: {
    title: string;
    description?: string;
    trackerSlug?: string;
    priority?: string;
    category?: string;
    issueType?: string;
    labels?: string[];
    anonymous: boolean;
  }
): Promise<unknown> {
  if (writeRateLimited(userId)) return { error: 'External write rate limit reached — try again later.' };
  const mode = witMode(userId, params.anonymous);
  const title = params.title.trim().slice(0, 500);
  if (!title) return { error: 'title is required' };
  const body: Record<string, unknown> = {
    title,
    description: params.description?.trim().slice(0, 20000) || undefined,
    tracker_slug: params.trackerSlug || undefined,
    priority: params.priority || undefined,
    category: params.category || undefined,
    issue_type: params.issueType || undefined,
    labels: params.labels?.slice(0, 10),
    reporter: mode === 'owner' ? OWNER_REPORTER : undefined,
  };
  const res = await witFetch('/create-issue', mode, { method: 'POST', body });
  if (!res.ok || !res.data?.success) {
    return { error: 'Failed to create issue', detail: res.data?.message || res.data?.code };
  }
  return {
    ok: true,
    postedAs: mode === 'owner' ? 'Jacob (authenticated)' : 'anonymous',
    slug: res.data?.issue?.slug,
    url: issueUrl(res.data?.issue?.slug),
  };
}

export async function toolWitCreateTracker(
  userId: string,
  params: {
    name: string;
    description?: string;
    location?: string;
    sourceUrl?: string;
    sourceUrlIsDefault?: boolean;
    anonymous: boolean;
  }
): Promise<unknown> {
  const identity = resolveWitTrackerCreationMode(userId, params.anonymous);
  if ('error' in identity) return identity;
  if (writeRateLimited(userId)) return { error: 'External write rate limit reached — try again later.' };
  const { mode } = identity;
  const name = params.name.trim().slice(0, 200);
  if (!name) return { error: 'name is required' };
  const sourceUrl = params.sourceUrl?.trim() || undefined;
  const res = await witFetch('/create-tracker', mode, {
    method: 'POST',
    body: {
      name,
      description: params.description?.trim().slice(0, 20000) || undefined,
      location: params.location?.trim().slice(0, 500) || undefined,
      source_url: sourceUrl,
      source_url_is_default: sourceUrl ? params.sourceUrlIsDefault === true : undefined,
    },
  });
  const data = res.data ?? {};
  if (res.status === 409 && (data.code === 'tracker_name_exists' || data.code === 'tracker_slug_exists')) {
    return {
      duplicate: true,
      message: 'A tracker with this name already exists — reuse it instead of creating a duplicate.',
      existing: data.tracker ? { name: data.tracker.name, slug: data.tracker.slug, url: data.tracker.url } : null,
    };
  }
  if (res.status === 429) {
    return { error: 'Tracker creation is rate-limited right now — try again later.', retryAfterSeconds: data.retry_after_seconds };
  }
  if (!res.ok || !data.success || !data.tracker?.slug) {
    return { error: 'Failed to create tracker', detail: data.message || data.code || data.error };
  }
  const createdAs = data.creator?.kind === 'anonymous' ? 'anonymous' : 'Jacob (authenticated)';
  return {
    ok: true,
    createdAs,
    slug: data.tracker.slug,
    url: data.tracker.url || `${WIT_SITE}/tracker/${data.tracker.slug}`,
    ...(data.ownership_warning
      ? { ownership_warning: data.ownership_warning, note: 'Tracker created, but ownership assignment failed; do not describe it as owned by the account.' }
      : createdAs === 'anonymous'
      ? { note: 'Created anonymously: public, listed, and not owned by any account.' }
      : {}),
  };
}

export async function toolWitUpdateIssue(
  userId: string,
  params: {
    issueId: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    category?: string;
    issueType?: string;
    labels?: string[];
  }
): Promise<unknown> {
  // Updating requires authenticated ownership on WIT — owner-only, no
  // anonymous fallback. Non-owner users are refused here, server-side.
  if (!isOwnerUser(userId)) {
    return { error: 'Updating issues is only available to the account owner. You can create a new issue or comment instead.' };
  }
  if (witAgentKey().length === 0) return { error: 'Issue tracker write access is not configured on the server.' };
  if (writeRateLimited(userId)) return { error: 'External write rate limit reached — try again later.' };
  const body: Record<string, unknown> = { issue_id: params.issueId };
  if (params.title !== undefined) body.title = params.title.trim().slice(0, 500);
  if (params.description !== undefined) body.description = params.description.slice(0, 20000);
  if (params.status !== undefined) body.status = params.status;
  if (params.priority !== undefined) body.priority = params.priority;
  if (params.category !== undefined) body.category = params.category;
  if (params.issueType !== undefined) body.issue_type = params.issueType;
  if (params.labels !== undefined) body.labels = params.labels.slice(0, 10);
  const res = await witFetch('/update-issue', 'owner', { method: 'POST', body });
  if (!res.ok) return { error: 'Failed to update issue', detail: res.data?.message || res.data?.code };
  return { ok: true, issue: compactIssue(res.data?.issue ?? res.data) };
}

export async function toolWitComment(
  userId: string,
  params: { issueId: string; content: string; anonymous: boolean }
): Promise<unknown> {
  if (writeRateLimited(userId)) return { error: 'External write rate limit reached — try again later.' };
  const mode = witMode(userId, params.anonymous);
  const content = params.content.trim().slice(0, 20000);
  if (!content) return { error: 'content is required' };
  const res = await witFetch('/create-comment', mode, {
    method: 'POST',
    body: {
      issue_id: params.issueId,
      content,
      author_name: mode === 'owner' ? OWNER_REPORTER : 'Anonymous',
    },
  });
  if (!res.ok || res.data?.success === false) {
    return { error: 'Failed to post comment', detail: res.data?.message || res.data?.code };
  }
  return { ok: true, postedAs: mode === 'owner' ? 'Jacob (authenticated)' : 'anonymous' };
}

// ─── unlinked.ai ─────────────────────────────────────────────────────────────
// The live unlinked.ai runtime exposes an account-scoped, search-only MCP
// endpoint (audience unlinked-account-tools-v1). The bearer grant is issued
// from the owner's Settings page and is Jacob's personal credential, so this
// surface is OWNER-ONLY — there is no anonymous unlinked API at all, and the
// service offers no agent write surface (posting/updating is browser-only).

const UNLINKED_MCP_URL = process.env.UNLINKED_MCP_URL || 'https://www.unlinked.ai/mcp';
const UNLINKED_TIMEOUT_MS = 60_000;

function unlinkedToken(): string {
  return (process.env.UNLINKED_ACCOUNT_TOKEN || '').trim();
}

let unlinkedRpcId = 0;

/** Minimal JSON-RPC tools/call client for the stateless Streamable-HTTP MCP endpoint. */
async function unlinkedMcpCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(UNLINKED_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${unlinkedToken()}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++unlinkedRpcId,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.timeout(UNLINKED_TIMEOUT_MS),
  });
  if (r.status === 401) return { error: 'unlinked.ai access is not authorized (grant missing or revoked).' };
  const contentType = r.headers.get('content-type') || '';
  let payload: any = null;
  if (contentType.includes('text/event-stream')) {
    // Single-response SSE: take the last `data:` line.
    const text = await r.text();
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    const last = dataLines[dataLines.length - 1];
    payload = last ? JSON.parse(last.slice(5).trim()) : null;
  } else {
    payload = await r.json().catch(() => null);
  }
  if (!r.ok || !payload) return { error: `unlinked.ai request failed (${r.status})` };
  if (payload.error) return { error: `unlinked.ai: ${payload.error.message || 'request rejected'}` };
  const content = payload.result?.content;
  const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : undefined;
  if (payload.result?.isError) return { error: text || 'unlinked.ai tool error' };
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { result: text };
    }
  }
  return payload.result ?? { error: 'empty unlinked.ai response' };
}

export async function toolUnlinkedSearch(
  userId: string,
  tool: 'unlinked_search_network' | 'unlinked_search_everyone',
  args: { query: string; degree?: 1 | 2 }
): Promise<unknown> {
  // Owner-only: the bearer grant is the owner's personal credential and
  // unlinked has no anonymous access mode for agents.
  if (!isOwnerUser(userId)) {
    return {
      error:
        'unlinked.ai search is only available to the account owner — it uses his personal network data and has no anonymous mode.',
    };
  }
  if (!unlinkedToken()) {
    return { error: 'unlinked.ai is not configured on the server yet.' };
  }
  const query = args.query.trim().slice(0, 1024);
  if (!query) return { error: 'query is required' };
  const callArgs: Record<string, unknown> = { query };
  if (tool === 'unlinked_search_network' && (args.degree === 1 || args.degree === 2)) {
    callArgs.degree = args.degree;
  }
  return unlinkedMcpCall(tool, callArgs);
}
