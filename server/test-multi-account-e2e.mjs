// End-to-end multi-account smoke for OpenChat. Drives three real Noos users
// (Alice, Bob, Charlie) plus picortex against the live chat.globalbr.ai
// stack. Goal: prove that DM + group + bot-in-group all work, with each
// user actually observing the other's messages via socket.io-client.
//
// Run: node server/test-multi-account-e2e.mjs
// Exits 0 on PASS, 1 on FAIL with a per-check report.
//
// Best-practice notes:
// - No JWT_SECRET / no Neo4j password is needed here — we use the public
//   Noos /api/auth/login endpoint, so this script is safe to run from
//   anywhere with network access.
// - Test accounts (alice@noos.app, bob@noos.app, charlie@noos.app) use
//   the publicly-known "password123" seed credential. They are NOT real
//   user accounts — never put real data through them.

import { io } from 'socket.io-client';

const NOOS_URL = process.env.NOOS_URL || 'https://globalbr.ai';
const OPENCHAT_URL = process.env.OPENCHAT_URL || 'https://chat.globalbr.ai';
const PICORTEX_BOT_ID = 'picortex_bot_7ecd2883dbd5ceef';

const failures = [];
const ok = (msg) => console.log('  ✓', msg);
const fail = (msg) => { failures.push(msg); console.log('  ✗', msg); };

async function noosLogin(email, password) {
  const r = await fetch(`${NOOS_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Noos login ${email}: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return { id: d.user.id, email: d.user.email, name: d.user.name, token: d.accessToken };
}

async function noosRegisterIfMissing(email, password, name) {
  try {
    return await noosLogin(email, password);
  } catch (e) {
    // Try register
    const r = await fetch(`${NOOS_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    if (!r.ok) throw new Error(`Noos register ${email}: ${r.status} ${await r.text()}`);
    const d = await r.json();
    return { id: d.user.id, email: d.user.email, name: d.user.name, token: d.accessToken };
  }
}

async function api(token, path, opts = {}) {
  const r = await fetch(`${OPENCHAT_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  return { status: r.status, json: r.ok ? await r.json() : null, text: r.ok ? null : await r.text() };
}

function connectSocket(user, label) {
  const s = io(OPENCHAT_URL, {
    auth: { token: user.token },
    transports: ['websocket'],
    reconnection: false,
  });
  s._label = label;
  s._inbox = [];
  s.on('message:new', (m) => s._inbox.push(m));
  s.on('participant:added', (e) => s._inbox.push({ _evt: 'participant:added', ...e }));
  s.on('conversation:created', (e) => s._inbox.push({ _evt: 'conversation:created', ...e }));
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(new Error(`${label} connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error(`${label} connect timeout`)), 10000);
  });
}

function waitForInbox(socket, predicate, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const hit = socket._inbox.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

(async () => {
  console.log('== OpenChat multi-account e2e ==');
  console.log(`NOOS_URL=${NOOS_URL}`);
  console.log(`OPENCHAT_URL=${OPENCHAT_URL}`);
  console.log();

  console.log('1. Sign in (or register) three test users');
  const alice = await noosRegisterIfMissing('alice@noos.app', 'password123', 'Alice');
  ok(`alice: ${alice.id}`);
  const bob = await noosRegisterIfMissing('bob@noos.app', 'password123', 'Bob');
  ok(`bob: ${bob.id}`);
  const charlie = await noosRegisterIfMissing('charlie@noos.app', 'password123', 'Charlie');
  ok(`charlie: ${charlie.id}`);

  console.log();
  console.log('2. Connect each user to socket.io');
  const aliceSock = await connectSocket(alice, 'alice');
  ok('alice socket connected');
  const bobSock = await connectSocket(bob, 'bob');
  ok('bob socket connected');
  const charlieSock = await connectSocket(charlie, 'charlie');
  ok('charlie socket connected');

  console.log();
  console.log('3. DIRECT: Alice <-> Bob');
  let dm = await api(alice.token, '/api/chat/conversations', {
    method: 'POST',
    body: JSON.stringify({ participantIds: [bob.id], type: 'direct' }),
  });
  if (dm.status !== 200 && dm.status !== 201) fail(`create DM: ${dm.status} ${dm.text}`);
  else ok(`DM conv ${dm.json.id} created`);
  const dmId = dm.json?.id;

  if (dmId) {
    // Both sockets must join the conversation room to receive message:new
    // conversation:join handler takes a raw string, not an object. The server
    // also auto-joins on create + add-participant, so these emits are usually
    // redundant — kept defensively for fresh-socket / dedupe-path cases.
    aliceSock.emit('conversation:join', dmId);
    bobSock.emit('conversation:join', dmId);
    await new Promise(r => setTimeout(r, 500));

    // Alice sends, Bob should see it
    aliceSock._inbox.length = 0;
    bobSock._inbox.length = 0;
    aliceSock.emit('message:send', { conversationId: dmId, content: 'e2e DM hi from alice' });
    const bobSaw = await waitForInbox(bobSock, m => m.conversationId === dmId && m.content === 'e2e DM hi from alice');
    if (bobSaw) ok('bob received alice DM message');
    else fail('bob did NOT receive alice DM message');

    // Bob replies, Alice should see it
    bobSock.emit('message:send', { conversationId: dmId, content: 'e2e DM ack from bob' });
    const aliceSaw = await waitForInbox(aliceSock, m => m.conversationId === dmId && m.content === 'e2e DM ack from bob');
    if (aliceSaw) ok('alice received bob DM reply');
    else fail('alice did NOT receive bob DM reply');
  }

  console.log();
  console.log('4. GROUP: Alice + Bob + Charlie');
  const group = await api(alice.token, '/api/chat/conversations', {
    method: 'POST',
    body: JSON.stringify({ participantIds: [bob.id, charlie.id], type: 'group', title: 'e2e group ' + Date.now() }),
  });
  if (group.status !== 200 && group.status !== 201) fail(`create group: ${group.status} ${group.text}`);
  else ok(`group conv ${group.json.id} created`);
  const groupId = group.json?.id;

  if (groupId) {
    // All three sockets join the group room
    aliceSock.emit('conversation:join', groupId);
    bobSock.emit('conversation:join', groupId);
    charlieSock.emit('conversation:join', groupId);
    await new Promise(r => setTimeout(r, 600));

    // Confirm the participants list includes all 3 (and that the server projects isBot correctly)
    const detail = await api(alice.token, `/api/chat/conversations/${groupId}`);
    const partIds = (detail.json?.participants || []).map(p => p.user.id).sort();
    const expected = [alice.id, bob.id, charlie.id].sort();
    if (JSON.stringify(partIds) === JSON.stringify(expected)) ok('group has all 3 expected participants');
    else fail(`group participants mismatch: got ${JSON.stringify(partIds)}, want ${JSON.stringify(expected)}`);

    // Charlie sends, Alice + Bob should both receive
    aliceSock._inbox.length = 0;
    bobSock._inbox.length = 0;
    charlieSock._inbox.length = 0;
    charlieSock.emit('message:send', { conversationId: groupId, content: 'group hello from charlie' });

    const a = await waitForInbox(aliceSock, m => m.conversationId === groupId && m.content === 'group hello from charlie');
    const b = await waitForInbox(bobSock, m => m.conversationId === groupId && m.content === 'group hello from charlie');
    if (a) ok('alice received charlie group message'); else fail('alice did NOT receive charlie group message');
    if (b) ok('bob received charlie group message'); else fail('bob did NOT receive charlie group message');

    // Alice adds picortex to the group; expect participant:added on the other two sockets
    aliceSock._inbox.length = 0;
    bobSock._inbox.length = 0;
    charlieSock._inbox.length = 0;
    const addBot = await api(alice.token, `/api/chat/conversations/${groupId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId: PICORTEX_BOT_ID }),
    });
    if (addBot.status !== 200 && addBot.status !== 201) fail(`add picortex: ${addBot.status} ${addBot.text}`);
    else ok('picortex added to group');

    const bobGotParticipantAdded = await waitForInbox(bobSock, m => m._evt === 'participant:added' && m.userId === PICORTEX_BOT_ID, 5000);
    if (bobGotParticipantAdded) ok('bob received participant:added event for picortex');
    else fail('bob did NOT receive participant:added for picortex');

    // Bot behavior checks — soft. picortex's attention/rate-limit logic is
    // its own concern; we count these as warnings so a flaky bot doesn't
    // hide real OpenChat infra regressions. Whether the bot replies or not,
    // the IMPORTANT thing is fan-out works: if it does reply, all members
    // see it.
    charlieSock._inbox.length = 0;
    aliceSock._inbox.length = 0;
    bobSock._inbox.length = 0;
    charlieSock.emit('message:send', { conversationId: groupId, content: '@picortex hello bot, please reply briefly so we can verify fan-out works' });
    const botReply = await waitForInbox(charlieSock, m => m.senderId === PICORTEX_BOT_ID && m.conversationId === groupId, 30000);
    if (botReply) {
      ok(`picortex replied to mention: "${(botReply.content || '').slice(0, 80)}"`);
      const aliceSawBot = await waitForInbox(aliceSock, m => m.senderId === PICORTEX_BOT_ID && m.conversationId === groupId, 3000);
      const bobSawBot = await waitForInbox(bobSock, m => m.senderId === PICORTEX_BOT_ID && m.conversationId === groupId, 3000);
      if (aliceSawBot && bobSawBot) ok('bot reply fanned out to all group members');
      else fail(`bot reply fan-out incomplete: alice=${!!aliceSawBot} bob=${!!bobSawBot}`);
    } else {
      console.log('  ⚠ picortex did NOT reply to mention within 30s — not failing this check; picortex own attention/rate logic is out of scope for OpenChat infra correctness');
    }
  }

  console.log();
  console.log('5. Cleanup sockets');
  aliceSock.disconnect();
  bobSock.disconnect();
  charlieSock.disconnect();

  console.log();
  if (failures.length === 0) {
    console.log('=> PASS — all checks green');
    process.exit(0);
  }
  console.log(`=> FAIL — ${failures.length} failure(s):`);
  for (const f of failures) console.log('   -', f);
  process.exit(1);
})().catch(err => {
  console.error('fatal:', err);
  process.exit(2);
});
