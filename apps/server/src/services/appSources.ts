export type AppIdentity = { issuer: string; subject: string } | null;
export function appBridgeConfigured(): boolean {
  return !!process.env.IDEAFLOW_BUILTIN_CLIENT_ID && !!process.env.IDEAFLOW_BUILTIN_CLIENT_SECRET;
}
const signalFor = (abort: AbortSignal | undefined, timeout: number): AbortSignal =>
  abort ? AbortSignal.any([abort, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
export async function readApp(identity: AppIdentity, app: 'vision' | 'openchat', tool: string, args: Record<string, unknown>, abort?: AbortSignal): Promise<unknown> {
  if (!identity || identity.issuer !== 'https://id.ideaflow.app/api/auth' || !identity.subject) return { error: 'Sign in using the same Ideaflow account to access this source.', code: 'account_link_required' };
  if (!appBridgeConfigured()) return { error: 'This source is not configured for this built-in agent.', code: 'not_configured' };
  if (!tool || tool.length > 100) return { error: 'A source tool name is required.' };
  try {
    const response = await fetch('https://id.ideaflow.app/builtin-agent/read', {
      method: 'POST', redirect: 'error', signal: signalFor(abort, 55000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(process.env.IDEAFLOW_BUILTIN_CLIENT_ID + ':' + process.env.IDEAFLOW_BUILTIN_CLIENT_SECRET).toString('base64') },
      body: JSON.stringify({ ...identity, app, tool, arguments: args }),
    });
    if (response.status === 409) return { error: `Sign into ${app} once with the same Ideaflow account to link this source.`, code: 'account_link_required' };
    if (!response.ok) return { error: 'Source unavailable or this tool is not permitted. No search result was retrieved.', code: 'source_unavailable' };
    return await response.json();
  } catch { return { error: 'Source unavailable. No search result was retrieved.', code: 'source_unavailable' }; }
}
export async function searchPublicNoos(query: string, abort?: AbortSignal): Promise<unknown> {
  if (!query.trim()) return { error: 'A search query is required.' };
  try {
    const response = await fetch('https://globalbr.ai/api/nodes/search/' + encodeURIComponent(query.trim().slice(0,300)) + '?limit=10', { redirect: 'error', signal: signalFor(abort,15000) });
    if (!response.ok) return { error: 'Noos public search is unavailable.' };
    const data = await response.json() as {nodes?: Array<{id?:string;slug?:string;title?:string;content?:string;type?:string}>};
    return { scope: 'public_only', nodes: (data.nodes || []).slice(0,10).map(n=>({ id:n.id,title:n.title,content:n.content?.slice(0,4000),type:n.type,url:'https://globalbr.ai/' + (n.slug ? 'n/' + encodeURIComponent(n.slug) : 'node/' + encodeURIComponent(n.id || '')) })) };
  } catch { return { error: 'Noos public search is unavailable.' }; }
}
export async function listPublicIssues(query: string, abort?: AbortSignal): Promise<unknown> {
  if (!process.env.WIT_ANON_KEY) return { error: 'World Issue Tracker is not configured.' };
  try {
    const response = await fetch('https://qmzopiburflputowkuhu.supabase.co/functions/v1/get-issues?limit=100', { redirect:'error', signal:signalFor(abort,15000), headers:{apikey:process.env.WIT_ANON_KEY} });
    if (!response.ok) return {error:'World Issue Tracker is unavailable.'};
    const data = await response.json() as {issues?: Array<{id?:string;slug?:string;title?:string;description?:string;status?:string}>};
    const rows = data.issues || [], q = query.trim().toLowerCase();
    return { scope:'public_only', coverage:'Filters the latest 100 issues; not an exhaustive search.', issues: rows.filter(i=>!q || `${i.title || ''} ${i.description || ''}`.toLowerCase().includes(q)).slice(0,10).map(i=>({id:i.id,title:i.title,description:i.description?.slice(0,3000),status:i.status,url:'https://worldissuetracker.com/issue/' + encodeURIComponent(i.slug || i.id || '')})) };
  } catch { return {error:'World Issue Tracker is unavailable.'}; }
}
