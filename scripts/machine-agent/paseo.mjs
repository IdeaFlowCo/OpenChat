// Use the client shipped with the operator's pinned Paseo installation. No remote SDK/endpoint discovery.
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

export async function connectLocal() {
  const path = process.env.OPENCHAT_PASEO_SDK;
  const port = Number(process.env.OPENCHAT_PASEO_PORT);
  if (!path || !isAbsolute(path) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Configure the local Paseo SDK and port');
  const { createPaseoClient } = await import(pathToFileURL(realpathSync(path)).href);
  const client = createPaseoClient({
    url: 'ws://127.0.0.1:' + port + '/ws',
    password: process.env.PASEO_PASSWORD,
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();
  return client;
}

export function checkScope(agent, job) {
  if (
    !agent ||
    agent.id !== job.agent ||
    agent.cwd !== job.workspace ||
    agent.archivedAt ||
    agent.provider !== 'codex' ||
    !['auto', 'read-only'].includes(job.mode) ||
    agent.currentModeId !== job.mode ||
    agent.status !== 'idle' ||
    agent.activeTurn ||
    agent.pendingPermissions?.length
  )
    throw Error('Bound agent must be idle with its locally approved permissions and workspace');
}
export async function requireScoped(client) {
  try {
    const response = await client.localApprovedTurn({ op: 'probe' });
    if (response.version === 2 && response.status === 'supported') return;
  } catch {}
  throw Error('This Paseo SDK and daemon need the reviewed local approved-turn operation.');
}
export async function bindGrant(client, g) {
  const response = await client.localApprovedTurn({ op: 'bind', route: g.route, proof: g.localProof });
  if (response.version !== 2 || response.status !== 'bound')
    throw Error('A fresh, idle dedicated agent is required.');
}
export async function interruptDispatched(state, client, route) {
  const g = state.grant(route);
  if (!g || g.state !== 'revoked') throw Error('Revoke the grant first.');
  if (!g.stage || ['done', 'review', 'interrupted'].includes(g.stage)) return true;
  const result = await client.localApprovedTurn({
    op: 'cancel',
    route: g.route,
    proof: g.localProof,
    item: g.request,
  });
  if (result.version !== 2 || result.status !== 'stopped' || result.item !== g.request || !result.turnId)
    return false;
  return !!state.db
    .prepare(
      "UPDATE grants SET stage='interrupted' WHERE route=? AND state='revoked' AND request=? AND daemonTurn=? AND stage='native-terminal' AND EXISTS(SELECT 1 FROM native_requests n WHERE n.route=grants.route AND n.request=grants.request AND n.turn=grants.nativeTurn AND n.thread=grants.nativeThread)",
    )
    .run(route, g.request, result.turnId).changes;
}
export async function runReviewed(authority, client, job, consent, signal) {
  const finish = (status, text, turnId) => authority.finish(job, status, text, turnId);
  try {
    await requireScoped(client);
    checkScope((await client.agents.ref(job.agent).refresh())?.agent, job);
    if (!(await consent(job, signal))) return finish('denied', 'Declined on the machine.');
    if (signal.aborted) return;
    const permit = authority.dispatch(job);
    if (!permit) return finish('expired', 'Approval expired.');
    const result = await client.localApprovedTurn({ op: 'run', ...permit });
    if (
      result.version === 2 &&
      result.status === 'result' &&
      result.item === job.id &&
      typeof result.text === 'string' &&
      result.turnId
    )
      return finish('result', result.text, result.turnId);
    return finish('attention', 'No verified completed turn. Review the dedicated agent on the machine.');
  } catch {
    return finish(
      'error',
      'The scoped Paseo operation is unavailable or unconfirmed. Review the dedicated agent on the machine.',
    );
  }
}
