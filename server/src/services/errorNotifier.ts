/**
 * Error notifier — pushes server errors to Slack (or any webhook URL) so
 * Jacob sees them within seconds without grep-tailing docker logs.
 *
 * Gate: SLACK_ERROR_WEBHOOK_URL env var. If unset, the entire module is a
 * no-op. Set it on the deploy host (Lightsail /opt/openchat/.env) to a
 * Slack Incoming Webhook URL — POSTs a simple Block-Kit message.
 *
 * Rate limiting: an in-memory hash table debounces identical errors. The
 * same error signature (status + first line of the error message) won't
 * notify more than once per ERROR_SIGNATURE_TTL_MS (60 s by default). A
 * counter-with-flush approach was considered and rejected — Slack rate
 * limits, the existing docker logs are authoritative, and Jacob already
 * has the bash script for paging through bursts.
 *
 * Failure mode: webhook errors are swallowed (logged to console.warn). We
 * never want the error-notifier to itself cause a noisy outage.
 *
 * Why not Sentry / Datadog / etc.: those are great but require a paid
 * account or a new dependency. SLACK_ERROR_WEBHOOK_URL is the lowest-
 * friction "standard and immediate" path Jacob asked for (2026-06-01).
 */

const SIGNATURE_TTL_MS = 60_000;
const MAX_BODY_CHARS = 1500;

const lastNotifiedAt = new Map<string, number>();

function signature(scope: string, message: string): string {
  // Strip volatile bits (timestamps, ids) so similar errors collapse.
  const cleaned = message
    .replace(/[0-9a-f-]{16,}/gi, '<ID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '<TIME>')
    .split('\n')[0]
    .slice(0, 200);
  return `${scope}:${cleaned}`;
}

interface NotifyParams {
  /** Short tag of where the error came from, e.g. 'http:GET /api/thoughts' */
  scope: string;
  /** Human-readable error message. */
  message: string;
  /** Optional structured context — request path, user id, status code. */
  context?: Record<string, unknown>;
  /** Optional stack (first ~10 lines are sent). */
  stack?: string;
}

function shouldThrottle(sig: string): boolean {
  const now = Date.now();
  const prev = lastNotifiedAt.get(sig) ?? 0;
  if (now - prev < SIGNATURE_TTL_MS) return true;
  lastNotifiedAt.set(sig, now);
  return false;
}

/**
 * Fire-and-forget notify. Safe to call from anywhere — never throws.
 */
export function notifyError(params: NotifyParams): void {
  const url = process.env.SLACK_ERROR_WEBHOOK_URL;
  if (!url) return;

  const sig = signature(params.scope, params.message);
  if (shouldThrottle(sig)) return;

  // Build a compact Slack message. Single text block — Block-Kit
  // formatting kept minimal so this still works with any "Incoming
  // Webhook"-compatible endpoint (Slack, Discord, Mattermost, …).
  const stackLines = (params.stack ?? '').split('\n').slice(0, 8).join('\n');
  const ctxLines = params.context
    ? Object.entries(params.context)
        .map(([k, v]) => `*${k}*: \`${String(v).slice(0, 200)}\``)
        .join(' · ')
    : '';

  const lines: string[] = [];
  lines.push(`:rotating_light: *${params.scope}*`);
  lines.push(`> ${params.message.slice(0, 500)}`);
  if (ctxLines) lines.push(ctxLines);
  if (stackLines) lines.push('```' + stackLines + '```');

  let body = lines.join('\n');
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '…';

  // Best-effort POST. Slack's webhook returns 200 with body 'ok' on success.
  void (async () => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
    } catch (err) {
      // NEVER recurse into ourselves — just log.
      console.warn('[error-notifier] webhook POST failed:', err);
    }
  })();
}

/**
 * Express error-handler middleware — wire as the LAST app.use(). Forwards
 * any error (HTTP 5xx) bubbled out of a route handler to the notifier.
 *
 * Use:
 *   import errorNotifier from './middleware/errorNotifier'; // or via this file
 *   app.use(errorNotifier);
 */
export function errorNotifierMiddleware(
  err: Error & { status?: number; statusCode?: number },
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
): void {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) {
    notifyError({
      scope: `http:${req.method} ${req.path}`,
      message: err.message || 'Unhandled server error',
      context: {
        status,
        userId: (req as { user?: { userId?: string } }).user?.userId ?? null,
        ip: req.ip,
      },
      stack: err.stack,
    });
  }
  next(err);
}

/**
 * Convenience wrapper for ad-hoc reporting inside try/catch blocks.
 *   try { ... } catch (e) { reportCaughtError('foo', e, { extra }); }
 */
export function reportCaughtError(scope: string, err: unknown, context?: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  notifyError({ scope, message: e.message, context, stack: e.stack });
}
