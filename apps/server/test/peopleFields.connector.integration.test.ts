import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

// Exercise People fields, note edits and duplicate review through the same
// signed MCP -> delegated REST -> overlay -> Neo4j path used by an agent.
// Only synthetic people and credentials are used in the optional transcript.
integration('person fields, note revisions and duplicate decisions through the shared connector', { timeout: 60000 }, () => {
  const suffix = randomUUID();
  const owner = `fields-owner-${suffix}`, other = `fields-other-${suffix}`;
  const secret = 'synthetic-merge-connector-secret-at-least-32-bytes';
  const actorId = `ideaflow-grant:${suffix}`;
  const transcript: unknown[] = [];
  let driver: Driver, server: Server, base: string;
  let graph: typeof import('../src/services/privateGraph.js');

  beforeAll(async () => {
    vi.stubEnv('NEO4J_URI', uri!);
    vi.stubEnv('NEO4J_USER', user!);
    vi.stubEnv('NEO4J_PASSWORD', password!);
    vi.stubEnv('IDEAFLOW_CONNECTOR_SECRET', secret);
    vi.stubEnv('JWT_SECRET', secret);
    graph = await import('../src/services/privateGraph.js');
    await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const db = driver.session();
    try {
      await db.run(`UNWIND $ids AS id CREATE (:User {id:id,name:id,email:id+'@example.test',
        ideaflowIssuer:'https://id.ideaflow.app/api/auth',ideaflowSub:id})`, { ids: [owner, other] });
    } finally { await db.close(); }
    const { handleIdeaflowConnector, connectorOperationGuard } = await import('../src/routes/ideaflowConnector.js');
    const { default: routes, privateGraphBody } = await import('../src/routes/privateGraph.js');
    const app = express();
    app.post('/api/connector/mcp', express.raw({ type: 'application/json', limit: '7mb' }), handleIdeaflowConnector);
    app.use(privateGraphBody);
    app.use(express.json());
    app.use('/api', connectorOperationGuard);
    app.use('/api/private', routes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60000);

  afterAll(async () => {
    try {
      if (process.env.PEOPLE_FIELDS_EVIDENCE_DIR) {
        await mkdir(process.env.PEOPLE_FIELDS_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(process.env.PEOPLE_FIELDS_EVIDENCE_DIR, 'people-fields-api.json'), JSON.stringify({
          surface: 'Signed Ideaflow MCP connector and owner REST API backed by disposable Neo4j',
          fixtures: 'Synthetic people only; authentication headers omitted', transcript,
        }, null, 2));
      }
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (driver) {
        const db = driver.session();
        try {
          for (const id of [owner, other]) await db.executeWrite(tx => graph.deletePrivateGraphForUser(tx, id));
          await db.run('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u', { ids: [owner, other] });
        } finally { await db.close(); await driver.close(); }
        await (await import('../src/db.js')).getDriver().close();
      }
      vi.unstubAllEnvs();
    }
  }, 60000);

  async function call(name: string, args: Record<string, unknown>, options: { scope?: string; owner?: string; actor?: boolean } = {}) {
    const scope = options.scope ?? 'openchat:read openchat:write';
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://id.ideaflow.app/connector', aud: 'https://chat.ideaflow.app/mcp',
      identity_issuer: 'https://id.ideaflow.app/api/auth', sub: options.owner ?? owner,
      scope, iat: now, exp: now + 60, jti: randomUUID(), client: 'Synthetic People resolver',
      ...(options.actor === false ? {} : { actor_id: actorId }),
      body_sha256: createHash('sha256').update(body).digest('hex'),
    })).toString('base64url');
    const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
    const response = await fetch(`${base}/api/connector/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body,
    });
    const rpc = await response.json() as any;
    const data = rpc.result?.content?.[0]?.text ? JSON.parse(rpc.result.content[0].text) : rpc.error;
    transcript.push({ tool: name, arguments: args, scope, owner: options.owner ?? owner, httpStatus: response.status, isError: rpc.result?.isError ?? !response.ok, response: data });
    return { status: response.status, isError: rpc.result?.isError ?? !response.ok, data };
  }
  async function ok(name: string, args: Record<string, unknown>, options?: Parameters<typeof call>[2]) {
    const result = await call(name, args, options);
    expect(result, name).toMatchObject({ status: 200, isError: false });
    return result.data;
  }
  async function rest(path: string, signedIn = true, method = 'GET', body?: unknown) {
    const token = jwt.sign({ userId: owner, email: 'synthetic@example.test' }, secret, { expiresIn: '1m' });
    const response = await fetch(`${base}/api/private${path}`, { method, headers: { 'Content-Type': 'application/json', ...(signedIn ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    transcript.push({ rest: `${method} /api/private${path}`, signedIn, httpStatus: response.status, response: data });
    return { status: response.status, data: data as any };
  }
  async function person(sourceId: string, name = 'Synthetic Morgan Lee') {
    return (await ok('oc_import_contact_source', { source: 'synthetic:address-book', sourceId, name,
      data: { schemaVersion: 1, email: `${sourceId.startsWith('pair2') ? 'second' : 'morgan'}@example.test` } })).entity.id as string;
  }
  const merge = (ids: string[], operationId: string) => ({ ids, headId: ids[0], rule: 'same-underlying-contact', evidence: ['synthetic verified card identity'], operationId });

  it('edits a private note without changing its identity and refuses a stale edit', async () => {
    const saved = await ok('oc_save_private_thing', { kind: 'person', name: 'Synthetic Nora Rivera' });
    const note = await ok('oc_add_private_note', { subjectKind: 'thing', subjectId: saved.id, text: 'Met at the garden workshop' });
    const edit = await ok('oc_update_private_note', { noteId: note.id, text: 'Met at the community garden workshop', ifRevision: 1 });
    expect(edit).toMatchObject({ id: note.id, createdAt: note.createdAt, revision: 2, text: 'Met at the community garden workshop' });
    const stale = await rest(`/notes/${note.id}`, true, 'PATCH', { text: 'An obsolete edit', ifRevision: 1 });
    expect(stale).toMatchObject({ status: 409, data: { code: 'stale_revision', note: { id: note.id, revision: 2, text: edit.text } } });
    const history = await ok('oc_list_note_revisions', { noteId: note.id }, { scope: 'openchat:read' });
    expect(history.revisions).toEqual([expect.objectContaining({ revision: 1, text: note.text, replacedBy: 'agent:Synthetic People resolver' })]);
    expect((await ok('oc_get_private_thing', { thingId: saved.id })).notes).toEqual([expect.objectContaining({ id: note.id, text: edit.text, revision: 2 })]);
    expect(await call('oc_list_note_revisions', { noteId: note.id }, { owner: other })).toMatchObject({ isError: true, data: { code: 'not_found' } });
    const db = driver.session();
    try {
      const rows = await db.run('MATCH (n:OverlayNote {id:$id}) MATCH (r:OverlayNoteRevision {noteId:$id}) RETURN n.editedByActorId AS editorActorId, r.replacedByActorId AS revisionActorId', { id: note.id });
      const actors = rows.records.map(r => ({ editorActorId: r.get('editorActorId'), revisionActorId: r.get('revisionActorId') }));
      expect(actors).toEqual([{ editorActorId: actorId, revisionActorId: actorId }]);
      transcript.push({ persistedNoteActors: actors });
    } finally { await db.close(); }
  });

  it('keeps field history, accepts note suggestions, masks Wi-Fi and persists the verified writer', async () => {
    const saved = await ok('oc_save_private_thing', { kind: 'person', name: 'Synthetic Eli Chen' });
    await ok('oc_add_private_note', { subjectKind: 'thing', subjectId: saved.id, text: 'Email eli@example.test. Birthday is June 14.' });
    const detail = await ok('oc_get_private_thing', { thingId: saved.id });
    expect(detail.fields).toEqual([]);
    const email = detail.fieldSuggestions.find((s: any) => s.kind === 'email');
    const birthday = detail.fieldSuggestions.find((s: any) => s.kind === 'birthday');
    expect(email).toMatchObject({ value: { text: 'eli@example.test' } });
    expect(birthday).toBeDefined();
    const accepted = await ok('oc_set_person_field', { thingId: saved.id, suggestionId: email.id, clientRequestId: 'accept-email' });
    expect(accepted.fields).toContainEqual(expect.objectContaining({ kind: 'email', status: 'current', assertions: [expect.objectContaining({ source: 'note', recordedBy: 'agent:Synthetic People resolver' })] }));
    const dismissed = await ok('oc_mark_person_field', { thingId: saved.id, action: 'dismiss', suggestionId: birthday.id, clientRequestId: 'dismiss-birthday' });
    expect(dismissed.fieldSuggestions.some((s: any) => s.id === birthday.id)).toBe(false);
    const old = await ok('oc_set_person_field', { thingId: saved.id, kind: 'address', value: '832 Addison St, Berkeley', source: 'imessage', observedAt: '2017-01-30', status: 'former', clientRequestId: 'old-address' });
    expect(old.fields.find((f: any) => f.key === old.key)).toMatchObject({ status: 'former', observedAt: '2017-01-30' });
    const currentArgs = { thingId: saved.id, kind: 'address', value: '123 Oak Street', clientRequestId: 'current-address' };
    const current = await ok('oc_set_person_field', currentArgs);
    const replay = await ok('oc_set_person_field', currentArgs);
    expect(replay).toMatchObject({ operationId: current.operationId, assertionId: current.assertionId, replayed: true });
    expect(replay.fields.find((f: any) => f.key === current.key).assertions).toHaveLength(1);
    const replacement = await ok('oc_set_person_field', { thingId: saved.id, kind: 'address', value: '456 Pine Road', supersedes: current.key, clientRequestId: 'new-address' });
    expect(replacement.fields.find((f: any) => f.key === current.key).status).toBe('former');
    expect(replacement.fields.find((f: any) => f.key === replacement.key)).toMatchObject({ status: 'current', primary: true, conflict: false });
    const marked = await ok('oc_mark_person_field', { thingId: saved.id, action: 'wrong', key: replacement.key, clientRequestId: 'wrong-address' });
    expect(marked.fields.find((f: any) => f.key === replacement.key).status).toBe('wrong');
    const undo = await ok('oc_mark_person_field', { thingId: saved.id, action: 'undo', operationId: marked.operationId, clientRequestId: 'undo-wrong' });
    expect(undo.fields.find((f: any) => f.key === replacement.key).status).toBe('current');
    const inferred = await ok('oc_set_person_field', { thingId: saved.id, kind: 'context', value: 'Qigong', contextType: 'interest', assertion: 'inferred', clientRequestId: 'inferred-interest' });
    expect(inferred.fields.find((f: any) => f.key === inferred.key)).toMatchObject({ status: 'review', value: { text: 'Qigong', type: 'interest' } });

    const wifiArgs = { thingId: saved.id, kind: 'wifi', ssid: 'Synthetic Guest Network', password: 'synthetic-password-only', clientRequestId: 'guest-wifi' };
    const wifi = await ok('oc_set_person_field', wifiArgs);
    const masked = { ssid: wifiArgs.ssid, password: null, secret: true };
    expect(wifi.fields.find((f: any) => f.key === wifi.key).value).toMatchObject(masked);
    const reread = await ok('oc_get_private_thing', { thingId: saved.id });
    expect(reread.fields.find((f: any) => f.key === wifi.key).value).toMatchObject(masked);
    expect(JSON.stringify(reread)).not.toContain(wifiArgs.password);
    const fields = await rest(`/things/${saved.id}/fields`);
    expect(fields.status).toBe(200);
    expect(fields.data.fields.find((f: any) => f.key === wifi.key).value).toMatchObject(masked);
    const reveal = await ok('oc_get_person_field', { thingId: saved.id, key: wifi.key }, { scope: 'openchat:read' });
    expect(reveal.value.password).toBe(wifiArgs.password);
    expect(await call('oc_get_person_field', { thingId: saved.id, key: wifi.key }, { owner: other })).toMatchObject({ isError: true, data: { code: 'not_found' } });
    expect((await call('oc_set_person_field', currentArgs, { scope: 'openchat:read' })).status).toBe(403);
    expect(await call('oc_set_person_field', { ...currentArgs, clientRequestId: 'no-actor' }, { actor: false })).toMatchObject({ isError: true, data: { error: 'Stable agent identity could not be verified' } });
    expect((await rest(`/things/${saved.id}/fields`, false)).status).toBe(401);
    const db = driver.session();
    try {
      const rows = await db.run(`MATCH (n) WHERE (n:OverlayFieldAssertion OR n:OverlayFieldDecision OR n:OverlayFieldOperation) AND n.entityId=$id
        RETURN labels(n)[0] AS label, n.actorId AS actorId, count(n) AS total ORDER BY label`, { id: saved.id });
      const actors = rows.records.map(r => ({ label: r.get('label'), actorId: r.get('actorId'), total: r.get('total').toNumber() }));
      expect(actors.map(r => r.label).sort()).toEqual(['OverlayFieldAssertion', 'OverlayFieldDecision', 'OverlayFieldOperation']);
      expect(actors.every(r => r.actorId === actorId)).toBe(true);
      transcript.push({ persistedFieldActors: actors });
    } finally { await db.close(); }
  });

  it('keeps reviewed people separate until the decision is undone, without deleting its history', async () => {
    const a = await person('different-a'), b = await person('different-b'), c = await person('different-c');
    const args = { ids: [a,b,c], operationId: 'review-different', reason: 'Same name, different people' };
    const marked = await ok('oc_mark_different_people', args);
    expect(marked).toMatchObject({ decisions: 3, replayed: false });
    expect(await ok('oc_mark_different_people', args)).toMatchObject({ decisions: 3, replayed: true });
    const decisions = await ok('oc_list_identity_decisions', { ids: [a,b,c] }, { scope: 'openchat:read' });
    expect(decisions.decisions).toHaveLength(3);
    expect(await ok('oc_list_identity_decisions', { ids: [a,b,c] }, { owner: other })).toEqual({ decisions: [] });
    const blocked = await ok('oc_merge_people', { merges: [merge([a,b], 'blocked-by-review')] });
    expect(blocked.results).toEqual([{ index: 0, error: 'cannot_link' }]);
    expect(await ok('oc_undo_different_people', { operationId: args.operationId })).toEqual({ revoked: 3 });
    expect(await ok('oc_undo_different_people', { operationId: args.operationId })).toEqual({ revoked: 0 });
    expect(await ok('oc_list_identity_decisions', { ids: [a,b,c] })).toEqual({ decisions: [] });
    expect((await ok('oc_merge_people', { merges: [merge([a,b], 'merge-after-undo')] })).results[0]).toMatchObject({ merged: true, headId: a });
    const db = driver.session();
    try {
      const rows = await db.run('MATCH (d:OverlayIdentityDecision {operationId:$op}) RETURN d.actorId AS actorId, d.revokedByActorId AS revokedByActorId, d.revokedAt IS NOT NULL AS revoked', { op: args.operationId });
      const history = rows.records.map(r => ({ actorId: r.get('actorId'), revokedByActorId: r.get('revokedByActorId'), revoked: r.get('revoked') }));
      expect(history).toHaveLength(3);
      expect(history.every(r => r.actorId === actorId && r.revokedByActorId === actorId && r.revoked)).toBe(true);
      transcript.push({ persistedIdentityDecisions: history });
    } finally { await db.close(); }
  });
});

