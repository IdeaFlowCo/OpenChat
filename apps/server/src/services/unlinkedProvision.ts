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
