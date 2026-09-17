import { createHash, timingSafeEqual } from 'node:crypto';

export const IDEAFLOW_LINK_FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LINK_FLOWS = 10_000;

interface PendingLinkFlow {
  userId: string;
  sessionHash: string;
  nonce: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface IdeaflowLinkFlowInput {
  state: string;
  userId: string;
  authorization: string;
  nonce: string;
  codeChallenge: string;
}

export interface IdeaflowLinkFlowExchangeInput {
  state: string;
  userId: string;
  authorization: string;
  nonce: string;
  codeVerifier: string;
}

// OpenChat currently runs one API process. These short-lived entries bind the
// linking callback to the exact authenticated session that started it and are
// deliberately lost on restart. Move them to shared storage before adding API
// replicas; a lost entry fails closed and only requires restarting the link.
const pendingLinkFlows = new Map<string, PendingLinkFlow>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function equalDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(authorization: string): string | null {
  return authorization.startsWith('Bearer ') && authorization.length > 7
    ? authorization.slice(7)
    : null;
}

function pruneExpired(now: number): void {
  for (const [state, flow] of pendingLinkFlows) {
    if (flow.expiresAt <= now) pendingLinkFlows.delete(state);
  }
}

/**
 * Reserve a state exactly once. A repeated state never overwrites the user,
 * session, nonce, or PKCE challenge recorded by the original request.
 */
export function rememberIdeaflowLinkFlow(
  input: IdeaflowLinkFlowInput,
  now = Date.now(),
): boolean {
  const token = bearerToken(input.authorization);
  if (!token) return false;

  pruneExpired(now);
  if (pendingLinkFlows.has(input.state) || pendingLinkFlows.size >= MAX_PENDING_LINK_FLOWS) {
    return false;
  }

  pendingLinkFlows.set(input.state, {
    userId: input.userId,
    sessionHash: digest(token),
    nonce: input.nonce,
    codeChallenge: input.codeChallenge,
    expiresAt: now + IDEAFLOW_LINK_FLOW_TTL_MS,
  });
  return true;
}

/**
 * Atomically consume and validate a link flow before exchanging its provider
 * code. Account switches, replacement JWTs, nonce/PKCE mismatches, expiry, and
 * replay all fail closed. Even a failed validation burns the state.
 */
export function consumeIdeaflowLinkFlow(
  input: IdeaflowLinkFlowExchangeInput,
  now = Date.now(),
): boolean {
  const flow = pendingLinkFlows.get(input.state);
  pendingLinkFlows.delete(input.state);
  if (!flow || flow.expiresAt <= now) return false;

  const token = bearerToken(input.authorization);
  if (!token) return false;

  return flow.userId === input.userId
    && equalDigest(flow.sessionHash, digest(token))
    && equalDigest(flow.nonce, input.nonce)
    && equalDigest(flow.codeChallenge, digest(input.codeVerifier));
}

/** Test-only reset for the process-local pending registry. */
export function resetIdeaflowLinkFlows(): void {
  pendingLinkFlows.clear();
}
