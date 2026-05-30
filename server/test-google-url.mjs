// Smoke test: bring up the auth router in isolation, hit /google/url,
// verify the constructed URL has all the right pieces. No Neo4j needed,
// since /google/url doesn't touch the DB. OpenChat-hwi.
import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const { default: authRoutes } = await import('./dist/routes/auth.js');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

const port = 7000 + Math.floor(Math.random() * 1000);
const server = app.listen(port, async () => {
  const failures = [];
  const ok = (msg) => console.log('  ✓', msg);
  const fail = (msg) => { failures.push(msg); console.log('  ✗', msg); };

  console.log(`smoke server up on :${port}`);
  console.log('');
  console.log('1. GET /api/auth/google/url with no params');
  try {
    const r = await fetch(`http://localhost:${port}/api/auth/google/url`, {
      headers: { Host: 'chat.globalbr.ai' },
    });
    if (!r.ok) {
      fail(`expected 200, got ${r.status}`);
    } else {
      const body = await r.json();
      const u = new URL(body.url);
      if (u.host !== 'accounts.google.com') fail(`bad host: ${u.host}`);
      else ok(`google host: ${u.host}`);

      const cid = u.searchParams.get('client_id');
      if (!cid || !cid.startsWith('874749606899')) fail(`bad client_id: ${cid}`);
      else ok(`client_id matches: ${cid.slice(0, 30)}...`);

      const scope = u.searchParams.get('scope');
      if (scope !== 'openid email profile') fail(`bad scope: ${scope}`);
      else ok(`scope: ${scope}`);

      const rt = u.searchParams.get('response_type');
      if (rt !== 'code') fail(`bad response_type: ${rt}`);
      else ok(`response_type: ${rt}`);

      if (!body.state || body.state.length < 8) fail(`weak state: ${body.state}`);
      else ok(`state generated (${body.state.length} chars)`);

      const stateInUrl = u.searchParams.get('state');
      if (stateInUrl !== body.state) fail('state mismatch between url and body');
      else ok('state round-trips into URL');

      if (!body.redirectUri) fail('no redirectUri returned');
      else ok(`redirectUri: ${body.redirectUri}`);
    }
  } catch (e) {
    fail(`fetch threw: ${e.message}`);
  }

  console.log('');
  console.log('2. GET /api/auth/google/url with explicit params');
  try {
    const r = await fetch(`http://localhost:${port}/api/auth/google/url?redirect_uri=http%3A//localhost%3A29231/auth/google/callback&state=test-state-1234567890&prompt=select_account`);
    if (!r.ok) { fail(`expected 200, got ${r.status}`); }
    else {
      const body = await r.json();
      const u = new URL(body.url);
      const redir = u.searchParams.get('redirect_uri');
      if (redir !== 'http://localhost:29231/auth/google/callback') fail(`bad redirect_uri: ${redir}`);
      else ok(`redirect_uri passed through: ${redir}`);

      if (body.state !== 'test-state-1234567890') fail(`state not preserved: ${body.state}`);
      else ok('state preserved');

      const prompt = u.searchParams.get('prompt');
      if (prompt !== 'select_account') fail(`bad prompt: ${prompt}`);
      else ok(`prompt forwarded: ${prompt}`);
    }
  } catch (e) {
    fail(`fetch threw: ${e.message}`);
  }

  console.log('');
  console.log('3. POST /api/auth/google/exchange with missing fields');
  try {
    const r = await fetch(`http://localhost:${port}/api/auth/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.status !== 400) fail(`expected 400 for missing code, got ${r.status}`);
    else ok(`400 on missing code (good)`);
  } catch (e) {
    fail(`fetch threw: ${e.message}`);
  }

  console.log('');
  console.log('4. POST /api/auth/google/exchange with a junk code (verifies it reaches Google + fails cleanly)');
  try {
    const r = await fetch(`http://localhost:${port}/api/auth/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'definitely-not-a-real-google-code', redirectUri: 'http://localhost:29231/auth/google/callback' }),
    });
    if (r.status !== 401) fail(`expected 401 for fake code, got ${r.status}`);
    else ok(`401 on invalid code (Google round-trip works)`);
  } catch (e) {
    fail(`fetch threw: ${e.message}`);
  }

  console.log('');
  if (failures.length) {
    console.log(`FAIL — ${failures.length} failure(s)`);
    for (const f of failures) console.log('  -', f);
    server.close();
    process.exit(1);
  } else {
    console.log('PASS — all checks green');
    server.close();
    process.exit(0);
  }
});
