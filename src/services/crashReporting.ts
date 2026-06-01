/**
 * Sentry crash reporting scaffold (OpenChat-7um).
 *
 * Gate: reads EXPO_PUBLIC_SENTRY_DSN at runtime. If the env var is undefined
 * or empty, this entire module is a no-op — no Sentry SDK code executes.
 *
 * To activate: create a Sentry project, copy the DSN, and add
 *   EXPO_PUBLIC_SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz
 * to the EAS secret store (or .env.local for local dev).
 *
 * PII scrubbing: scrubPii strips message content, emails (domain masked),
 * and JWTs from Sentry events and breadcrumbs before they leave the device.
 */

import * as Sentry from '@sentry/react-native';
import type { ErrorEvent, EventHint } from '@sentry/core';

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

function scrubPii(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  // Scrub exception values.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = redactString(ex.value);
      }
    }
  }
  // Scrub breadcrumbs. event.breadcrumbs may be typed oddly in Sentry 6.x;
  // cast to a plain object to avoid iterator type issues.
  const bc = event.breadcrumbs as { values?: Array<{ message?: string; data?: Record<string, unknown> }> } | undefined;
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
  // Scrub extra / contexts.
  if (event.extra) {
    event.extra = scrubValue(event.extra) as Record<string, unknown>;
  }
  return event;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Call once at app boot, before installClientLogger().
 * Returns immediately if the DSN env var is not set.
 */
export function initCrashReporting(): void {
  if (initialized) return;
  initialized = true;

  if (!DSN) {
    // No DSN configured — silently skip. No console output; no-op is correct.
    return;
  }

  Sentry.init({
    dsn: DSN,
    environment: __DEV__ ? 'dev' : 'production',
    // 10 % of transactions sampled for performance monitoring.
    tracesSampleRate: 0.1,
    // Strip PII before events are sent.
    beforeSend: (event: ErrorEvent, hint: EventHint) => scrubPii(event, hint),
  });
}
