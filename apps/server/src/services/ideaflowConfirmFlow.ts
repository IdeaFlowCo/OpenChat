import { randomBytes } from 'node:crypto';
import type { IdeaflowIdentityClaims } from './ideaflowOidc.js';

/**
 * One-time ownership check kept inside Ideaflow sign-in. When an unmapped,
 * provider-verified Ideaflow identity matches exactly one existing OpenChat
 * password account that has no independent email proof, the server parks the
 * verified identity here and hands the (tab-held) confirm id to the client. The
 * person proves they own the account with its current password once; only then
 * is the identity bound.
 *
 * Deliberately process-local, like the link-flow registry: a restart loses
 * pending checks, which fails closed (the person just signs in again). Move to
 * shared storage before adding API replicas.
 */
export const IDEAFLOW_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const IDEAFLOW_CONFIRM_MAX_ATTEMPTS = 5;
export const IDEAFLOW_CONFIRM_MAX_REFUNDS = 5;
export const IDEAFLOW_CONFIRM_ACCOUNT_MAX_FAILURES = 10;
export const IDEAFLOW_CONFIRM_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const MAX_PENDING_CONFIRMS = 5_000;

interface PendingConfirm {
  identity: IdeaflowIdentityClaims;
  targetUserId: string;
  attempts: number;
  refunds: number;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirm>();
// Per-target-account failure cap, kept separately from any per-IP limiter so a
// flood from many confirm ids still cannot brute-force one account's password.
const accountFailures = new Map<string, number[]>();

function prune(now: number): void {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
  for (const [userId, failures] of accountFailures) {
    const recent = failures.filter(at => now - at < IDEAFLOW_CONFIRM_ACCOUNT_WINDOW_MS);
    if (recent.length === 0) accountFailures.delete(userId);
    else accountFailures.set(userId, recent);
  }
}

/** Park a verified identity; returns the unguessable id, or null if full. */
export function startIdeaflowConfirm(
  identity: IdeaflowIdentityClaims,
  targetUserId: string,
  now = Date.now(),
): string | null {
  prune(now);
  if (pending.size >= MAX_PENDING_CONFIRMS) return null;
  const id = randomBytes(32).toString('base64url');
  pending.set(id, {
    identity,
    targetUserId,
    attempts: 0,
    refunds: 0,
    expiresAt: now + IDEAFLOW_CONFIRM_TTL_MS,
  });
  return id;
}

export type ConfirmAttempt =
  | { ok: true; identity: IdeaflowIdentityClaims; targetUserId: string; reservedAt: number }
  | { ok: false; reason: 'expired' | 'locked' };

function removeReservation(targetUserId: string, reservedAt: number): void {
  const failures = accountFailures.get(targetUserId);
  if (!failures) return;
  const at = failures.indexOf(reservedAt);
  if (at >= 0) failures.splice(at, 1);
  if (failures.length === 0) accountFailures.delete(targetUserId);
}

/**
 * Begin one password attempt. The attempt is charged to both the flow and the
 * target account up front, so a burst of concurrent confirm ids cannot each get
 * a fresh allowance while earlier guesses are still in flight. A wrong password
 * simply keeps its charge; success or an unavailable verifier settles it.
 */
export function beginIdeaflowConfirmAttempt(id: string, now = Date.now()): ConfirmAttempt {
  prune(now);
  const entry = pending.get(id);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(id);
    return { ok: false, reason: 'expired' };
  }
  const failures = accountFailures.get(entry.targetUserId) ?? [];
  if (failures.length >= IDEAFLOW_CONFIRM_ACCOUNT_MAX_FAILURES) {
    return { ok: false, reason: 'locked' };
  }
  entry.attempts += 1;
  if (entry.attempts > IDEAFLOW_CONFIRM_MAX_ATTEMPTS) {
    pending.delete(id);
    return { ok: false, reason: 'locked' };
  }
  failures.push(now);
  accountFailures.set(entry.targetUserId, failures);
  return { ok: true, identity: entry.identity, targetUserId: entry.targetUserId, reservedAt: now };
}

/** A wrong (or unverifiable) password: the up-front charge stands. */
export function recordIdeaflowConfirmFailure(id: string): void {
  const entry = pending.get(id);
  if (entry && entry.attempts >= IDEAFLOW_CONFIRM_MAX_ATTEMPTS) pending.delete(id);
}

/**
 * The password oracle could not answer (outage, rate limit). That says nothing
 * about the person's password, so give the attempt back instead of locking out.
 * Refunds are bounded per check so an outage cannot become a free request loop.
 */
export function refundIdeaflowConfirmAttempt(id: string, attempt: { targetUserId: string; reservedAt: number }): void {
  const entry = pending.get(id);
  if (!entry || entry.refunds >= IDEAFLOW_CONFIRM_MAX_REFUNDS) return;
  entry.refunds += 1;
  removeReservation(attempt.targetUserId, attempt.reservedAt);
  if (entry.attempts > 0) entry.attempts -= 1;
}

/** Single use: a confirmed (or abandoned) check can never be replayed. */
export function finishIdeaflowConfirm(id: string, outcome: 'confirmed' | 'abandoned' = 'abandoned'): void {
  const entry = pending.get(id);
  if (entry && outcome === 'confirmed') accountFailures.delete(entry.targetUserId);
  pending.delete(id);
}

/** Test-only reset. */
export function resetIdeaflowConfirmFlows(): void {
  pending.clear();
  accountFailures.clear();
}
