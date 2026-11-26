import { mkdirSync, lstatSync, realpathSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { io } from 'socket.io-client';
import { Authority } from './authority.mjs';
import { connectLocal, checkScope, runReviewed } from './paseo.mjs';

process.umask(0o077);
const dir = process.env.OPENCHAT_MACHINE_HOME || join(homedir(), '.openchat-machine');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const owner = lstatSync(dir);
if (!owner.isDirectory() || owner.uid !== process.getuid() || owner.mode & 0o077)
  throw Error('Use an owner-only state directory');
const state = new Authority(join(dir, 'authority.db'));
const [command, id, agent, cwd] = process.argv.slice(2);
const offerFile = (route) => join(dir, route + '.offer');
const removeOffer = (route) => {
  if (existsSync(offerFile(route))) unlinkSync(offerFile(route));
};
const safe = (text) =>
  JSON.stringify(text).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function confirm(prompt, signal) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('A local interactive terminal is required');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(prompt, { signal })) === 'approve';
  } finally {
    terminal.close();
  }
}
function interruptDispatched(grant) {
  state.transaction(() => {
    const g = state.grant(grant.route);
    if (g.stage !== 'sent') return;
    const port = Number(process.env.OPENCHAT_PASEO_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid local Paseo port');
    execFileSync('paseo', ['stop', '--host', '127.0.0.1:' + port, g.agent], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    state.db.prepare("UPDATE grants SET stage='interrupted' WHERE route=?").run(g.route);
  });
}
async function main() {
  if (command === 'list') {
    for (const g of state.db.prepare('SELECT route,agent,workspace,state,expires,stage FROM grants').all())
      console.log(safe(g));
    return;
  }
  if (command === 'revoke') {
    const g = state.revoke(id);
    if (!g) throw Error('Unknown or revoked grant');
    removeOffer(id);
    // Agents are exclusive to one grant. Interrupt only when this grant crossed dispatch.
    try {
      interruptDispatched(g);
    } catch {
      console.error(
        'Grant revoked. Could not confirm interruption of the dispatched turn. Check the dedicated agent and retry revoke.',
      );
      process.exitCode = 1;
      return;
    }
    console.log('Revoked.');
    return;
  }
  if (command !== 'offer' && command !== 'serve')
    throw Error('Expected offer DEVICE_PUBLIC_KEY AGENT_ID WORKSPACE, serve ROUTE, list, or revoke ROUTE');
  const client = await connectLocal();
  if (command === 'offer') {
    try {
      const workspace = realpathSync(cwd);
      const snapshot = (await client.agents.ref(agent).refresh())?.agent;
      const mode = snapshot?.currentModeId;
      checkScope(snapshot, { agent, workspace, mode });
      if (
        !(await confirm(
          'Grant this device ' +
            safe(id) +
            ' one dedicated Codex agent ' +
            safe(agent) +
            ' using its existing ' +
            safe(mode) +
            ' tool permissions in ' +
            safe(workspace) +
            ' for 24 hours? Compare the full device key, then type approve: ',
        ))
      )
        return;
      const offer = state.offer(id, agent, workspace, mode);
      try {
        writeFileSync(offerFile(offer.route), offer.offer, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        state.revoke(offer.route);
        throw error;
      }
      console.log(
        'Private one-use offer file: ' + safe(offerFile(offer.route)) + '\nServe route: ' + offer.route,
      );
    } finally {
      await client.close();
    }
    return;
  }
  const g = state.grant(id);
  if (!g || g.state === 'revoked' || g.expires <= Date.now() || !process.stdin.isTTY || !process.stdout.isTTY)
    throw Error('An unexpired grant and interactive terminal are required');
  const relay = process.env.OPENCHAT_MACHINE_RELAY || 'https://chat.ideaflow.app';
  const url = new URL(relay);
  if (
    url.origin !== relay ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw Error('Use an HTTPS relay origin');
  const socket = io(relay + '/machine-agent-v1', {
    auth: { route: id, side: 'machine' },
    transports: ['websocket'],
    forceNew: true,
  });
  const controller = new AbortController();
  const expire = setInterval(() => {
    const grant = state.grant(id);
    if (grant.state !== 'pending' || Date.now() >= grant.offerUntil) removeOffer(id);
    if (
      grant.state === 'revoked' ||
      Date.now() >= grant.expires ||
      (grant.state === 'pending' && Date.now() >= grant.offerUntil)
    ) {
      controller.abort();
      socket.disconnect();
      clearInterval(expire);
      if (grant.state !== 'revoked') {
        const expired = state.revoke(id);
        try {
          if (expired) interruptDispatched(expired);
        } catch {
          console.error('Grant expired. Verify the outstanding turn on its dedicated agent.');
        }
      }
      void client.close();
    }
  }, 500);
  const budget = { reset: 0, count: 0 };
  socket.on('connect', () => console.log('Connected to the machine relay. Waiting for this device.'));
  socket.on('disconnect', () => console.log('Machine relay disconnected.'));
  socket.on('frame', async (wire) => {
    if (Date.now() > budget.reset) {
      budget.reset = Date.now() + 60_000;
      budget.count = 0;
    }
    if (++budget.count > 60) return;
    let item;
    try {
      item = state.admit(id, wire);
    } catch {
      return;
    }
    if (item?.reply && socket.connected) socket.emit('frame', item.reply);
    if (!item?.job) return;
    const result = await runReviewed(
      state,
      client,
      item.job,
      (j, signal) =>
        confirm(
          'Device requests a message to ' +
            safe(j.agent) +
            ' in ' +
            safe(j.workspace) +
            '\n' +
            safe(j.text) +
            '\nType approve to send this exact text: ',
          signal,
        ),
      controller.signal,
    );
    if (result && socket.connected && !controller.signal.aborted) socket.emit('frame', result);
  });
}
main().catch(() => {
  console.error(
    'Machine agent operation failed. Check the grant, local scope, terminal and configured Paseo connection.',
  );
  process.exit(1);
});
