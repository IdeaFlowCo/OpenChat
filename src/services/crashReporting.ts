/**
 * Sentry crash reporting scaffold (OpenChat-7um).
 *
 * Gate: reads EXPO_PUBLIC_SENTRY_DSN at runtime. If the env var is undefined
 * or empty, this entire module is a no-op — Sentry SDK is never imported.
 *
 * Web platform: hard-skipped. @sentry/react-native is RN-native only; pulling
 * it into the web bundle causes tslib resolution failures during Expo's web
 * export (verified empirically — broke /m/ and /d/ deploys until this guard
 * was added). Web has its own browser-level crash reporting if/when we need
 * it; do not add @sentry/browser through this module without re-checking the
 * web bundle.
 *
 * To activate (native iOS + Android):
 *   1. Create a Sentry project at https://sentry.io
 *   2. Copy the DSN
 *   3. Add EXPO_PUBLIC_SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz to
 *      the EAS production env (or .env.local for local dev)
 *
 * PII scrubbing: scrubPii strips message content, emails (domain masked),
 * and JWTs from Sentry events and breadcrumbs before they leave the device.
 */

import { Platform } from 'react-native';

// Expo public env vars are inlined at build time via babel-plugin-transform-inline-env.
// The `process.env` access is intentional — do not replace with a constant.
const DSN: string = process.env['EXPO_PUBLIC_SENTRY_DSN'] ?? '';

// ─── PII scrubbing ────────────────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@([a-zA-Z0-9.\-]+)/g;
const JWT_RE = /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/]*/g;

function redactString(s: string): string {
  return s
    .replace(JWT_RE, '[JWT_REDACTED]')
    .replace(EMAIL_RE, (_, domain) => `***@${domain}`);
}

function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // Drop keys that typically hold message content.
      if (['content', 'body', 'text', 'message', 'password', 'token'].includes(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubValue(val);
      }
    }
    return out;
  }
  return v;
}

// We type the scrubber loosely so this module doesn't pull in @sentry/core's
// types at compile-time. The shape is documented at
// https://docs.sentry.io/platforms/react-native/configuration/options/#before-send
interface SentryEventShape {
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: { values?: Array<{ message?: string; data?: Record<string, unknown> }> };
  extra?: Record<string, unknown>;
}

function scrubPii(event: SentryEventShape): SentryEventShape | null {
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = redactString(ex.value);
      }
    }
  }
  const bc = event.breadcrumbs;
  if (bc?.values) {
    for (const b of bc.values) {
      if (typeof b.message === 'string') {
        b.message = redactString(b.message);
      }
      if (b.data) {
        b.data = scrubValue(b.data) as Record<string, unknown>;
      }
    }
  }
  if (event.extra) {
    event.extra = scrubValue(event.extra) as Record<string, unknown>;
  }
  return event;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Call once at app boot, before installClientLogger().
 * Returns immediately if:
 *   - the DSN env var is not set, OR
 *   - we are running on web (Sentry SDK is RN-only here).
 */
export function initCrashReporting(): void {
  if (initialized) return;
  initialized = true;

  if (!DSN) return;
  if (Platform.OS === 'web') return;

  // Lazy require so that when the DSN is unset OR we are on web, the
  // @sentry/react-native module is NEVER touched by the bundler's resolution
  // graph. This is what keeps the web build from failing on tslib.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const Sentry = require('@sentry/react-native') as {
    init: (opts: Record<string, unknown>) => void;
  };

  Sentry.init({
    dsn: DSN,
    environment: __DEV__ ? 'dev' : 'production',
    tracesSampleRate: 0.1,
    beforeSend: (event: SentryEventShape) => scrubPii(event),
  });
}
