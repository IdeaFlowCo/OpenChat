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
export function extractReply(page, job) {
  if (page.agentId !== job.agent || page.error || page.gap || page.staleCursor)
    throw Error('Timeline unavailable');
  const users = page.entries.filter((entry) => entry.item.type === 'user_message');
  const source = users.at(-1);
  if (
    !source ||
    ![source.item.messageId, source.item.clientMessageId].includes(job.id) ||
    source.item.text !== job.text
  )
    throw Error('Turn identity unavailable');
  const candidates = page.entries.filter(
    (e) => e.seqStart > source.seqEnd && e.item.type === 'assistant_message',
  );
  const last = candidates.at(-1);
  if (
    !last ||
    !last.turnId ||
    (source.turnId && source.turnId !== last.turnId) ||
    candidates.some((e) => e.turnId !== last.turnId)
  )
    throw Error('Ambiguous agent output');
  return last.item.text;
}
export async function runReviewed(authority, client, job, consent, signal) {
  const ref = client.agents.ref(job.agent);
  const finish = (status, text) => authority.finish(job, status, text);
  try {
    checkScope((await ref.refresh())?.agent, job);
    if (!(await consent(job, signal))) return finish('denied', 'Declined on the machine.');
    checkScope((await ref.refresh())?.agent, job);
    if (signal.aborted) return;
    const dispatch = authority.dispatch(job, () => ref.send(job.text, { messageId: job.id }));
    if (!dispatch) return finish('expired', 'Approval expired. Nothing was sent.');
    await dispatch.started;
    const result = await ref.waitForFinish(120_000);
    if (result.status !== 'idle')
      return finish(
        'attention',
        'Paseo reported ' + String(result.status) + '. Review this turn on the machine.',
      );
    const page = await ref.timeline.refetch({ direction: 'tail', projection: 'projected', limit: 100 });
    const answer = extractReply(page, job);
    if (answer !== result.lastMessage) throw Error('Ambiguous agent output');
    return finish('result', answer);
  } catch {
    return finish(
      'error',
      'The machine could not verify a completed reply. Check the scoped agent before sending again.',
    );
  }
}
