/** Read-only Unlinked grants are provisioned for the verified OIDC identity.
 * Never cache a failed grant or replace a revoked grant with an owner token. */
export interface UnlinkedIdentity { issuer: string; subject: string }
export function unlinkedProvisionConfigured(): boolean {
  return !!process.env.UNLINKED_PROVISION_CLIENT_ID && !!process.env.UNLINKED_PROVISION_CLIENT_SECRET;
}
function failure(code: unknown): { error: string; code: string } {
  const safe = typeof code === "string" ? code : "upstream_unavailable";
  if (safe === "grant_revoked") return { code: safe, error: "Unlinked agent access was revoked. Re-enable it in Unlinked Settings to use this source." };
  if (safe === "not_linked") return { code: safe, error: "Sign into Unlinked once with the same Ideaflow account to link this source." };
  return { code: ["scope_not_granted", "rate_limited", "client_unauthorized", "not_found"].includes(safe) ? safe : "upstream_unavailable", error: "Unlinked is unavailable for this request. No search result was retrieved." };
}
export async function searchUnlinkedForIdentity(identity: UnlinkedIdentity | null, tool: "unlinked_search_network" | "unlinked_search_everyone", query: string, degree?: 1 | 2, abortSignal?: AbortSignal): Promise<unknown> {
  if (!identity || identity.issuer !== "https://id.ideaflow.app/api/auth" || !identity.subject) return failure("not_linked");
  if (!unlinkedProvisionConfigured()) return { code: "not_configured", error: "Unlinked is not configured for this agent yet." };
  if (!query.trim()) return { code: "invalid_input", error: "A search query is required." };
  const signal = (ms: number): AbortSignal => abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const base = (process.env.UNLINKED_API_BASE || "https://www.unlinked.ai").replace(/\/+$/, "");
  try {
    abortSignal?.throwIfAborted();
    const grantResponse = await fetch(base + "/api/agent/v1/provision-grant", {
      method: "POST", redirect: "error", signal: signal(15000),
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(process.env.UNLINKED_PROVISION_CLIENT_ID + ":" + process.env.UNLINKED_PROVISION_CLIENT_SECRET).toString("base64") },
      body: JSON.stringify(identity),
    });
    const grant = await grantResponse.json() as { accessToken?: string; error?: { code?: string } };
    if (!grantResponse.ok || typeof grant.accessToken !== "string" || !grant.accessToken) return failure(grant.error?.code);
    abortSignal?.throwIfAborted();
    const route = tool === "unlinked_search_network" ? "/search-network" : "/search-everyone";
    const response = await fetch(base + "/api/agent/v1" + route, {
      method: "POST", redirect: "error", signal: signal(60000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + grant.accessToken },
      body: JSON.stringify({ query: query.trim().slice(0, 1024), ...(tool === "unlinked_search_network" && degree ? { degree } : {}) }),
    });
    const result = await response.json() as { error?: { code?: string } };
    return response.ok && !result.error ? result : failure(result.error?.code);
  } catch {
    return failure("upstream_unavailable");
  }
}

/** One of the owner's own Unlinked contacts, as `unlinked_lookup_contact` answers it. */
export interface UnlinkedContact {
  connectionId: string | null;
  name: string;
  headline?: string;
  company?: string;
  /** SHA-256 hex of the canonical LinkedIn slug: the overlay ref `linkedin:in:<hash>`. */
  linkedinRefHash: string | null;
  publishedProfileId: string | null;
}
type LookupFailure = "not_linked" | "not_configured" | "not_found" | "grant_revoked" | "scope_not_granted" | "upstream_unavailable";
export type UnlinkedContactResult = { ok: true; contact: UnlinkedContact } | { ok: false; code: LookupFailure };
export type UnlinkedContactsResult = { ok: true; contacts: UnlinkedContact[] } | { ok: false; code: LookupFailure };
export type UnlinkedContactQuery = { profileId: string } | { connectionId: string } | { linkedinUrl: string } | { refHashes: string[] };

const HASH = /^[a-f0-9]{64}$/;
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
function contactOf(value: unknown): UnlinkedContact | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = text(input.name, 120) ?? "";
  const connectionId = typeof input.connectionId === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(input.connectionId) ? input.connectionId : null;
  const linkedinRefHash = typeof input.linkedinRefHash === "string" && HASH.test(input.linkedinRefHash) ? input.linkedinRefHash : null;
  const publishedProfileId = typeof input.publishedProfileId === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(input.publishedProfileId) ? input.publishedProfileId : null;
  if (!connectionId && !linkedinRefHash && !publishedProfileId) return null;
  const headline = text(input.headline, 256), company = text(input.company, 256);
  return { connectionId, name, ...(headline ? { headline } : {}), ...(company ? { company } : {}), linkedinRefHash, publishedProfileId };
}

/**
 * Ask Unlinked's owner-scoped contact lookup (`unlinked_lookup_contact`) with
 * the owner's own identity-scoped, read-only grant. It answers only the
 * owner's own imported contacts and published (public) profiles: a published
 * profile id resolves to its canonical id (a merged profile answers with the
 * one it moved to), and either way the answer carries the LinkedIn ref hash
 * and the published profile id when they exist.
 */
async function lookup(identity: UnlinkedIdentity | null, query: UnlinkedContactQuery): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: LookupFailure }> {
  if (!identity || identity.issuer !== "https://id.ideaflow.app/api/auth" || !identity.subject) return { ok: false, code: "not_linked" };
  if (!unlinkedProvisionConfigured()) return { ok: false, code: "not_configured" };
  const base = (process.env.UNLINKED_API_BASE || "https://www.unlinked.ai").replace(/\/+$/, "");
  try {
    const grantResponse = await fetch(base + "/api/agent/v1/provision-grant", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(process.env.UNLINKED_PROVISION_CLIENT_ID + ":" + process.env.UNLINKED_PROVISION_CLIENT_SECRET).toString("base64") },
      body: JSON.stringify(identity),
    });
    const grant = await grantResponse.json() as { accessToken?: string; error?: { code?: string } };
    if (!grantResponse.ok || typeof grant.accessToken !== "string" || !grant.accessToken) {
      const code = grant.error?.code;
      return { ok: false, code: code === "not_linked" || code === "grant_revoked" ? code : "upstream_unavailable" };
    }
    const response = await fetch(base + "/api/agent/v1/contacts/lookup", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + grant.accessToken },
      body: JSON.stringify(query),
    });
    const result = await response.json() as Record<string, unknown> & { error?: { code?: string } };
    if (!response.ok || result.error) {
      const code = result.error?.code;
      return { ok: false, code: code === "not_found" || code === "invalid_input" ? "not_found" : code === "scope_not_granted" ? "scope_not_granted" : code === "grant_revoked" ? "grant_revoked" : "upstream_unavailable" };
    }
    return { ok: true, body: result };
  } catch {
    return { ok: false, code: "upstream_unavailable" };
  }
}

/** One contact by published profile id, owner connection id or LinkedIn address. */
export async function lookupUnlinkedContactForIdentity(identity: UnlinkedIdentity | null, query: { profileId: string } | { connectionId: string } | { linkedinUrl: string }): Promise<UnlinkedContactResult> {
  const result = await lookup(identity, query);
  if (!result.ok) return result;
  const contact = contactOf(result.body.contact);
  return contact ? { ok: true, contact } : { ok: false, code: "not_found" };
}

/** The owner's imported contacts among these LinkedIn ref hashes (at most 100), in one call. */
export async function lookupUnlinkedContactsByHash(identity: UnlinkedIdentity | null, refHashes: string[]): Promise<UnlinkedContactsResult> {
  const hashes = [...new Set(refHashes.filter(value => HASH.test(value)))].slice(0, 100);
  if (!hashes.length) return { ok: true, contacts: [] };
  const result = await lookup(identity, { refHashes: hashes });
  if (!result.ok) return result;
  const contacts = Array.isArray(result.body.contacts) ? result.body.contacts.map(contactOf).filter((value): value is UnlinkedContact => value !== null) : [];
  return { ok: true, contacts };
}
