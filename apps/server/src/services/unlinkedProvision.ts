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

export type UnlinkedProfileResult =
  | { ok: true; profile: { id: string; name: string } }
  | { ok: false; code: "not_linked" | "not_configured" | "not_found" | "grant_revoked" | "scope_not_granted" | "upstream_unavailable" };

/**
 * Confirm that a profile id names a published Unlinked profile, read with the
 * owner's own identity-scoped, read-only grant. Returns the canonical id (a
 * merged profile answers with the one it moved to) and its public name.
 * Profiles that exist only in the owner's private import are not published
 * and are not confirmed here.
 */
export async function readUnlinkedProfileForIdentity(identity: UnlinkedIdentity | null, profileId: string): Promise<UnlinkedProfileResult> {
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
    const response = await fetch(base + "/api/agent/v1/people/" + encodeURIComponent(profileId), {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: "Bearer " + grant.accessToken },
    });
    const result = await response.json() as { profile?: { id?: unknown; name?: unknown }; error?: { code?: string } };
    if (!response.ok || result.error) {
      const code = result.error?.code;
      return { ok: false, code: code === "not_found" || code === "invalid_input" ? "not_found" : code === "scope_not_granted" ? "scope_not_granted" : code === "grant_revoked" ? "grant_revoked" : "upstream_unavailable" };
    }
    const id = result.profile?.id, name = result.profile?.name;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name.trim()) return { ok: false, code: "not_found" };
    return { ok: true, profile: { id, name: name.trim().slice(0, 120) } };
  } catch {
    return { ok: false, code: "upstream_unavailable" };
  }
}
