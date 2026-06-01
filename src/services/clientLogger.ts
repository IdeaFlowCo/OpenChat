/**
 * Mobile client logger (OpenChat-e5v).
 *
 * Forwards errors and warnings from the mobile app to the openchat server's
 * /api/client-logs endpoint so they show up in the same JSON log stream the
 * web client uses. Without this, mobile crashes were invisible to Jacob and
 * Sandeep's TestFlight bug reports had to be reproduced blind.
 *
 * Lifecycle: install() is called once from App.tsx at boot, BEFORE any
 * navigation or context providers, so even early-boot errors are captured.
 *
 * Hooked sources:
 *   - ErrorUtils.setGlobalHandler — uncaught native exceptions
 *   - globalThis 'unhandledrejection' — unhandled Promise rejections
 *   - explicit calls to logError / logWarn / logInfo from app code
 *
 * Transport: batched POST every BATCH_INTERVAL_MS (or immediately on
 * level='error'). Failures are dropped silently — we NEVER recurse into the
 * logger from logger-internal errors.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { OPENCHAT_URL } from '../api/client';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  } | null;
  context?: Record<string, unknown> | null;
  tags?: string[] | null;
}

interface Envelope extends LogEntry {
  platform: 'ios' | 'android' | 'web' | string;
  appVersion: string | undefined;
}

const BATCH_INTERVAL_MS = 1000;
const MAX_QUEUE = 200;
// When the queue gets this full we drop the oldest entries instead of buffering
// forever — protects against runaway loops.

const queue: Envelope[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
// Re-entrancy guard. If the flush itself throws / logs, swallow it instead of
// looping forever.
let flushing = false;

function appVersion(): string | undefined {
  return Constants.expoConfig?.version;
}

function makeEnvelope(entry: LogEntry): Envelope {
  return {
    ...entry,
    platform: Platform.OS,
    appVersion: appVersion(),
  };
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, BATCH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (flushing) return;
  if (queue.length === 0) return;
  flushing = true;
  // Drain the queue into a local batch so concurrent log calls can keep
  // queuing during the network request.
  const batch = queue.splice(0, queue.length);
  try {
    // Send one POST per entry — the server endpoint accepts a single log
    // object, not a batch. This is fine at the volumes we expect (sparse
    // errors, not high-frequency telemetry).
    await Promise.allSettled(
      batch.map((env) =>
        fetch(`${OPENCHAT_URL}/api/client-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(env),
        }).catch(() => {
          /* swallow — never recurse */
        })
      )
    );
  } finally {
    flushing = false;
  }
}

function enqueue(entry: LogEntry): void {
  if (queue.length >= MAX_QUEUE) {
    // Drop the oldest. We'd rather lose a few than buffer indefinitely.
    queue.splice(0, queue.length - MAX_QUEUE + 1);
  }
  queue.push(makeEnvelope(entry));
  if (entry.level === 'error') {
    void flush();
  } else {
    scheduleFlush();
  }
}

function serializeError(err: unknown): LogEntry['error'] {
  if (!err) return null;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

export function logError(message: string, err?: unknown, context?: Record<string, unknown>): void {
  enqueue({
    timestamp: new Date().toISOString(),
    level: 'error',
    message,
    error: serializeError(err),
    context: context ?? null,
  });
}

export function logWarn(message: string, context?: Record<string, unknown>): void {
  enqueue({
    timestamp: new Date().toISOString(),
    level: 'warn',
    message,
    error: null,
    context: context ?? null,
  });
}

export function logInfo(message: string, context?: Record<string, unknown>): void {
  enqueue({
    timestamp: new Date().toISOString(),
    level: 'info',
    message,
    error: null,
    context: context ?? null,
  });
}

/**
 * Install global error handlers. Idempotent — safe to call multiple times.
 * Should run as early as possible in App.tsx, ideally before NavigationContainer
 * mounts so that crashes during provider initialization are captured.
 */
export function installClientLogger(): void {
  if (installed) return;
  installed = true;

  // React Native: ErrorUtils is a global. Type isn't in @types/react-native;
  // declare a loose shape locally to avoid leaking `any` to callers.
  const errorUtils = (globalThis as unknown as {
    ErrorUtils?: {
      setGlobalHandler?: (handler: (err: unknown, isFatal?: boolean) => void) => void;
      getGlobalHandler?: () => (err: unknown, isFatal?: boolean) => void;
    };
  }).ErrorUtils;

  if (errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((err, isFatal) => {
      logError(
        isFatal ? 'Fatal uncaught error' : 'Uncaught error',
        err,
        { isFatal: !!isFatal }
      );
      // Chain to the previous handler so the default red-box / crash behavior
      // still fires in dev. In release builds the default handler is a no-op.
      if (previous) {
        try {
          previous(err, isFatal);
        } catch {
          /* swallow */
        }
      }
    });
  }

  // Promise rejections — Hermes / RN expose this via the global 'unhandledrejection'
  // event in newer versions. addEventListener may not exist on older runtimes;
  // guard accordingly.
  const g = globalThis as unknown as {
    addEventListener?: (
      type: string,
      handler: (ev: { reason?: unknown; promise?: unknown }) => void
    ) => void;
  };
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('unhandledrejection', (ev) => {
      logError('Unhandled promise rejection', ev?.reason, { source: 'unhandledrejection' });
    });
  }

  logInfo('clientLogger installed', { platform: Platform.OS, appVersion: appVersion() });
}
