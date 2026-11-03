// Security events: one JSON line on stdout per security-relevant outcome.
//
//   {"security_event": "...", "outcome": "success|failure|denied", "ts": "...",
//    "ip": "<req.ip>", "ua": "<≤200 chars>", "path": "...", "user_id"?: "...", ...extras}
//
// Lines go to the openchat_app container's stdout (Docker json-file); the
// host's log archiver ships them to GCS. Sibling of errorNotifier.ts: never
// throws, never blocks the request.
//
// Never log secrets. Keys that look like credentials (password, token,
// secret, otp, code, session, cookie, authorization, api_key) are dropped.
// `email` is replaced by `email_domain` + `email_hash` (first 12 hex of the
// sha256 of the lowercased address), so failures never carry raw emails.

import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Express `trust proxy`: only our own private hops. openchat_app is reached
 * from noos_nginx (Docker network / docker0 gateway) or loopback, so req.ip is
 * the address nginx saw and a client-supplied X-Forwarded-For from an
 * untrusted peer cannot choose its own logged address.
 */
export const TRUSTED_PROXY_SETTING = 'loopback, linklocal, uniquelocal';

export type SecurityOutcome = 'success' | 'failure' | 'denied';

export interface SecurityEventFields {
  req?: Request;
  user_id?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

const SECRET_FIELD = /pass(word)?|token|secret|otp|code|session|cookie|authori[sz]ation|^api_?key$|^key$|credential/i;

export function emailFingerprint(email: unknown): { email_domain?: string; email_hash?: string } {
  if (typeof email !== 'string' || !email.trim()) return {};
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  return {
    ...(at > 0 ? { email_domain: normalized.slice(at + 1).slice(0, 100) } : {}),
    email_hash: createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  };
}

function peerIsTrustedProxy(req: Request): boolean {
  try {
    const trust = req.app?.get?.('trust proxy fn') as ((addr: string, i: number) => boolean) | undefined;
    const peer = req.socket?.remoteAddress;
    return Boolean(trust && peer && trust(peer, 0));
  } catch {
    return false;
  }
}

function requestFields(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ua = req.get?.('user-agent');
  if (ua) out.ua = ua.slice(0, 200);
  out.path = (req.originalUrl || req.url || '').split('?')[0]!.slice(0, 200);
  out.method = req.method;
  // Edge-supplied client hints mean something only when our own proxy chain
  // delivered the request; a direct caller could set them to anything.
  if (peerIsTrustedProxy(req)) {
    const cf = req.get?.('cf-connecting-ip');
    if (cf) out.cf_connecting_ip = cf.slice(0, 64);
    const xff = req.get?.('x-forwarded-for');
    if (xff) out.xff = xff.slice(0, 200);
  }
  return out;
}

export function buildSecurityEvent(
  event: string,
  outcome: SecurityOutcome,
  fields: SecurityEventFields = {},
): Record<string, unknown> {
  const { req, email, user_id, ...extras } = fields;
  const line: Record<string, unknown> = {
    security_event: event,
    outcome,
    ts: new Date().toISOString(),
    ...(req ? requestFields(req) : {}),
  };
  const userId = user_id ?? req?.user?.userId;
  if (userId) line.user_id = String(userId);
  if (req?.agentKeyId && !('agent_key_id' in extras)) line.agent_key_id = req.agentKeyId;
  Object.assign(line, emailFingerprint(email));
  for (const [key, value] of Object.entries(extras)) {
    if (value === undefined || SECRET_FIELD.test(key) || key in line) continue;
    line[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return line;
}

/** Emit one security event line to stdout. Never throws. */
export function securityEvent(
  event: string,
  outcome: SecurityOutcome,
  fields: SecurityEventFields = {},
): void {
  try {
    process.stdout.write(JSON.stringify(buildSecurityEvent(event, outcome, fields)) + '\n');
  } catch (err) {
    console.warn(`[security-event] dropped ${event}: ${(err as Error).message}`);
  }
}

/** Log every 429 response as a `rate_limited` event, whichever limiter sent it. */
export function securityRateLimitMonitor(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (res.statusCode === 429) securityEvent('rate_limited', 'denied', { req, status: 429 });
  });
  next();
}
