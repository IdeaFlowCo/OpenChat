import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

interface ApprovalGrant {
  actor: string;
  action: string;
  payloadDigest: Buffer;
  expiresAt: number;
}

const grants = new Map<string, ApprovalGrant>();
const GRANT_TTL_MS = 10 * 60 * 1000;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(payload: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest();
}

function removeExpiredGrants(now: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
}

export function issuePublicationApproval(actor: string, action: string, payload: unknown): string {
  const now = Date.now();
  removeExpiredGrants(now);
  const token = randomUUID();
  grants.set(token, { actor, action, payloadDigest: digest(payload), expiresAt: now + GRANT_TTL_MS });
  return token;
}

export function consumePublicationApproval(
  token: unknown,
  actor: string,
  action: string,
  payload: unknown,
): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const grant = grants.get(token);
  if (!grant) return false;
  grants.delete(token);
  const payloadDigest = digest(payload);
  return grant.expiresAt > Date.now()
    && grant.actor === actor
    && grant.action === action
    && timingSafeEqual(grant.payloadDigest, payloadDigest);
}
