import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const seen = new Map<string, number>();
export type ConnectorIdentity = {
  sub: string;
  identity_issuer: string;
  scope: string;
  jti: string;
  /** The agent client's registered name, from the hub's grant (optional; older hubs omit it). */
  client?: string;
};
/** This assertion is only accepted by /connector/mcp, never by REST auth. */
export function verifyConnectorAssertion(
  token: string,
  body: Buffer,
  secret: string,
): ConnectorIdentity | null {
  if (Buffer.byteLength(secret) < 32 || token.length > 8192) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [header, payload, signature] = parts;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    const h = JSON.parse(Buffer.from(header, "base64url").toString());
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    if (
      h.alg !== "HS256" ||
      h.crit ||
      p.iss !== "https://id.ideaflow.app/connector" ||
      p.aud !== "https://chat.ideaflow.app/mcp" ||
      p.identity_issuer !== "https://id.ideaflow.app/api/auth" ||
      typeof p.sub !== "string" ||
      !p.sub ||
      p.sub.length > 200 ||
      typeof p.jti !== "string" ||
      !p.jti ||
      p.jti.length > 200 ||
      !Number.isSafeInteger(p.iat) ||
      !Number.isSafeInteger(p.exp) ||
      p.iat > now + 5 ||
      p.exp <= now ||
      p.exp <= p.iat ||
      p.exp - p.iat > 60 ||
      typeof p.scope !== "string" ||
      !p.scope ||
      !p.scope
        .split(" ")
        .every((scope: string) => ["openchat:read", "openchat:write"].includes(scope)) ||
      p.body_sha256 !== createHash("sha256").update(body).digest("hex")
    )
      return null;
    for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id);
    if (seen.has(p.jti) || seen.size >= 10000) return null;
    seen.set(p.jti, p.exp);
    // A client name is provenance only, never authority: keep it when well formed, otherwise drop it.
    // eslint-disable-next-line no-control-regex -- deliberate control-character check
    const client = typeof p.client === "string" && p.client.trim() && p.client.length <= 100 && !/[\u0000-\u001f\u007f]/.test(p.client) ? p.client.trim() : undefined;
    return { sub: p.sub, identity_issuer: p.identity_issuer, scope: p.scope, jti: p.jti, ...(client ? { client } : {}) };
  } catch {
    return null;
  }
}

type Principal = { id: string; scopes: string[]; client?: string };
const principals = new WeakMap<Request, Principal>();
function markConnectorRequest(request: Request, principal: Principal): void {
  principals.set(request, principal);
}
export function getConnectorPrincipal(request: Request): Principal | undefined {
  return principals.get(request);
}

// Server-only, one-use internal delegation. Never a session or API key, and
// never returned to the connector. Bound to the operation already authorized
// by the MCP controller; an arbitrary REST path/body cannot reuse it.
const pending = new Map<
  string,
  { id: string; scopes: string[]; client?: string; method: string; path: string; hash: string; expiry: number }
>();
const bodyHash = (body: unknown): string =>
  createHash("sha256")
    .update(body === undefined ? "" : JSON.stringify(body))
    .digest("hex");
export function issueConnectorOperation(
  id: string,
  operation: { method: string; path: string; body?: unknown },
  scopes: string[],
  client?: string,
): string {
  const now = Date.now();
  for (const [key, value] of pending) if (value.expiry <= now) pending.delete(key);
  if (pending.size >= 10000) throw new Error("Connector operation capacity reached");
  const token = `ifop_${randomBytes(32).toString("base64url")}`;
  pending.set(token, {
    id,
    scopes,
    ...(client ? { client } : {}),
    method: operation.method,
    path: operation.path,
    hash: bodyHash(operation.body),
    expiry: now + 30000,
  });
  return token;
}
export function consumeConnectorOperation(token: string, request: Request): { id: string } | null {
  const op = pending.get(token);
  if (!op) return null;
  pending.delete(token);
  // express.json leaves GET bodies undefined; path includes the exact query.
  if (
    op.expiry <= Date.now() ||
    op.method !== request.method ||
    op.path !== request.originalUrl ||
    op.hash !== bodyHash(request.body)
  )
    return null;
  markConnectorRequest(request, { id: op.id, scopes: op.scopes, ...(op.client ? { client: op.client } : {}) });
  return { id: op.id };
}

export function revokeConnectorOperation(token: string): void { pending.delete(token); }
