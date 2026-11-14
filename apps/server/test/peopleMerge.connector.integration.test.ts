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

// Exercise the same signed MCP -> delegated REST -> overlay -> Neo4j path used
// by an agent. Only synthetic people and credentials are used in the transcript.
integration('people pointer merge through the shared connector', { timeout: 60000 }, () => {
  const suffix = randomUUID();
  const owner = `merge-owner-${suffix}`, other = `merge-other-${suffix}`;
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
      if (process.env.PEOPLE_MERGE_EVIDENCE_DIR) {
        await mkdir(process.env.PEOPLE_MERGE_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(process.env.PEOPLE_MERGE_EVIDENCE_DIR, 'people-merge-api.json'), JSON.stringify({
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
  async function rest(path: string, signedIn = true) {
    const token = jwt.sign({ userId: owner, email: 'synthetic@example.test' }, secret, { expiresIn: '1m' });
    const response = await fetch(`${base}/api/private${path}`, { headers: signedIn ? { Authorization: `Bearer ${token}` } : {} });
    const data = await response.json();
    transcript.push({ rest: `GET /api/private${path}`, signedIn, httpStatus: response.status, response: data });
    return { status: response.status, data: data as any };
  }
  async function person(sourceId: string, name = 'Synthetic Morgan Lee') {
    return (await ok('oc_import_contact_source', { source: 'synthetic:address-book', sourceId, name,
      data: { schemaVersion: 1, email: `${sourceId.startsWith('pair2') ? 'second' : 'morgan'}@example.test` } })).entity.id as string;
  }
  const merge = (ids: string[], operationId: string) => ({ ids, headId: ids[0], rule: 'same-underlying-contact', evidence: ['synthetic verified card identity'], operationId });

  it('collapses duplicates, keeps member data, redirects writes and exactly reverts an independently committed batch', async () => {
    const a = await person('pair1-a'), b = await person('pair1-b');
    const c = await person('pair2-a', 'Synthetic Robin Chen'), d = await person('pair2-b', 'Synthetic Robin Chen');
    const company = await ok('oc_save_private_thing', { kind: 'company', name: 'Synthetic Workshop' });
    const before = await ok('oc_list_private_things', { kind: 'person', details: true });
    expect(before.things.map((p: any) => p.id).sort()).toEqual([a,b,c,d].sort());
    await ok('oc_add_private_note', { subjectKind: 'thing', subjectId: a, text: 'Head original note' });
    const memberNote = await ok('oc_add_private_note', { subjectKind: 'thing', subjectId: b, text: 'Member original note' });
    const memberLink = await ok('oc_add_private_link', { subjectKind: 'thing', subjectId: b, relation: 'works at', toKind: 'company', toId: company.id });
    const merges = [merge([a,b], 'pair1'), merge([a,company.id], 'invalid-kind'), merge([c,d], 'pair2')];
    for (const tool of ['oc_merge_people', 'oc_split_person', 'oc_revert_merge']) {
      const args = tool === 'oc_merge_people' ? { merges } : tool === 'oc_split_person' ? { thingId:b, operationId:'denied-split' } : { batchId:'synthetic-batch' };
      expect((await call(tool, args, { scope: 'openchat:read' })).status).toBe(403);
    }
    expect((await rest('/merge-events', false)).status).toBe(401);
    const noActor = await call('oc_merge_people', { merges: [merges[0]] }, { actor: false });
    expect(noActor).toMatchObject({ isError: true, data: { error: 'Stable agent identity could not be verified' } });
    const foreign = await ok('oc_merge_people', { merges: [merge([a,b], 'foreign')] }, { owner: other });
    expect(foreign.results).toEqual([{ index:0, error:'not_found' }]);
    const batch = await ok('oc_merge_people', { merges, batchId: 'synthetic-batch' });
    expect(batch.results).toEqual([
      expect.objectContaining({ index:0, merged:true, headId:a, memberIds:expect.arrayContaining([a,b]) }),
      { index:1, error:'merge_kind' },
      expect.objectContaining({ index:2, merged:true, headId:c, memberIds:expect.arrayContaining([c,d]) }),
    ]);
    expect((await ok('oc_merge_people', { merges:[merges[0]], batchId:'synthetic-batch' })).results[0]).toMatchObject({ replayed:true, eventId:batch.results[0].eventId });
    const list = await ok('oc_list_private_things', { kind:'person', details:true });
    expect(list.total).toBe(2);
    expect(list.things.map((p: any) => p.id).sort()).toEqual([a,c].sort());
    expect(list.things.find((p: any) => p.id === a).members.map((m: any) => m.id).sort()).toEqual([a,b].sort());
    expect((await rest('/things?kind=person&summary=true')).data.things).toEqual(expect.arrayContaining([expect.objectContaining({id:a,members:expect.any(Array)})]));
    const detail = await ok('oc_get_private_thing', { thingId:b });
    expect(detail).toMatchObject({id:a,requestedId:b});
    expect(detail.notes.map((n: any) => n.text).sort()).toEqual(['Head original note','Member original note']);
    expect(detail.links).toContainEqual(expect.objectContaining({id:memberLink.id}));
    const state = await ok('oc_get_contact_state', { thingId:b });
    expect(state).toMatchObject({thingId:a,requestedId:b});
    expect(state.contactSources).toHaveLength(2);
    expect(state.members.map((m: any) => m.id).sort()).toEqual([a,b].sort());
    const written = await ok('oc_add_private_note', {subjectKind:'thing',subjectId:b,text:'Written through merged member'});
    await ok('oc_save_people_state', {thingId:b,operationId:'merged-state',expectedRevision:0,payload:{schemaVersion:1,tag:'redirected'}});
    const db = driver.session();
    try {
      const persisted = await db.run(`MATCH (n:OverlayNote) WHERE n.id IN $ids RETURN n.id AS id,n.entityId AS entityId ORDER BY n.id`, {ids:[memberNote.id,written.id]});
      const rows = persisted.records.map(r => ({id:r.get('id'),entityId:r.get('entityId')}));
      expect(rows).toContainEqual({id:memberNote.id,entityId:b});
      expect(rows).toContainEqual({id:written.id,entityId:a});
      transcript.push({ persistedNotes:rows, meaning:'Original member note stayed on its record; new member-addressed note landed on the head' });
    } finally { await db.close(); }
    const events = await ok('oc_list_merge_events', {batchId:'synthetic-batch'}, {scope:'openchat:read'});
    expect(events.events).toHaveLength(2);
    expect(events.events.every((e: any) => e.actorId === actorId && e.actor === 'agent:Synthetic People resolver')).toBe(true);
    const undoArgs = {batchId:'synthetic-batch',operationId:'batch-undo'};
    const undone = await ok('oc_revert_merge', undoArgs);
    expect(undone.reverted.sort()).toEqual([batch.results[0].eventId,batch.results[2].eventId].sort());
    expect(await ok('oc_revert_merge', undoArgs)).toEqual(undone);
    expect((await ok('oc_revert_merge', {batchId:'synthetic-batch'})).skipped.sort()).toEqual(undone.reverted.sort());
    expect((await ok('oc_list_private_things', {kind:'person'})).total).toBe(4);
    const restoredMember = await ok('oc_get_private_thing', {thingId:b});
    expect(restoredMember.id).toBe(b);
    expect(restoredMember.requestedId).toBeUndefined();
    expect(restoredMember.notes.map((n: any) => n.text)).toEqual(['Member original note']);
    expect(restoredMember.contactSources).toHaveLength(1);
    expect((await ok('oc_get_contact_state', {thingId:a})).peopleState.payload.tag).toBe('redirected');
  });

  it('refuses dependent reverts and remerges of split people; enforces batch bounds', async () => {
    const a = await person('dependency-a'), b = await person('dependency-b'), c = await person('dependency-c');
    const first = (await ok('oc_merge_people', {merges:[merge([a,b],'dependency-first')]})).results[0];
    const second = (await ok('oc_merge_people', {merges:[merge([a,c],'dependency-second')]})).results[0];
    const refused = await call('oc_revert_merge', {eventId:first.eventId});
    expect(refused).toMatchObject({isError:true,data:{code:'merge_superseded',eventId:first.eventId,dependencyId:second.eventId}});
    expect((await ok('oc_get_private_thing', {thingId:b})).members).toHaveLength(3);
    await ok('oc_revert_merge', {eventId:second.eventId,operationId:'undo-second'});
    expect((await ok('oc_get_private_thing', {thingId:b})).members).toHaveLength(2);
    await ok('oc_revert_merge', {eventId:first.eventId,operationId:'undo-first'});
    const args = {merges:[merge([a,b],'split-setup')]};
    await ok('oc_merge_people', args);
    const splitArgs = {thingId:b,operationId:'split-b',reason:'Synthetic records confirmed different'};
    const split = await ok('oc_split_person', splitArgs);
    expect(split).toMatchObject({id:b,replayed:false});
    expect(await ok('oc_split_person', splitArgs)).toMatchObject({id:b,replayed:true,event:split.event});
    expect((await ok('oc_get_private_thing', {thingId:b})).id).toBe(b);
    expect((await ok('oc_merge_people', {merges:[merge([a,b],'forbidden-remerge')]})).results).toEqual([{index:0,error:'cannot_link'}]);
    expect((await call('oc_merge_people', {merges:[]}))).toMatchObject({isError:true,data:{code:'invalid_merge_batch'}});
    expect((await call('oc_merge_people', {merges:Array.from({length:26},()=>merge([a,c],'too-many'))})).status).toBe(400);
    // Twenty-five requests actually execute, not just schema validation.
    const full = await ok('oc_merge_people', {merges:Array.from({length:25},(_,i)=>merge([a,c],`full-${i}`)),batchId:'full-batch'});
    expect(full.results.map((r: any) => r.index)).toEqual(Array.from({length:25},(_,i)=>i));
    expect(full.results.every((r: any) => !r.error)).toBe(true);
    expect(full.results.filter((r: any) => r.merged)).toHaveLength(1);
    expect((await ok('oc_list_merge_events', {batchId:'full-batch'})).events).toHaveLength(25);
    await ok('oc_revert_merge', {batchId:'full-batch'});
  });

  it('preserves separate People state and OpenChat account identities', async () => {
    const a = await person('state-a'), b = await person('state-b');
    for (const [thingId, tag] of [[a,'first'],[b,'second']]) {
      await ok('oc_save_people_state', {thingId,operationId:`state-${tag}`,expectedRevision:0,payload:{schemaVersion:1,tag}});
    }
    expect((await ok('oc_merge_people', {merges:[merge([a,b],'state-conflict')]})).results).toEqual([{index:0,error:'merge_state_conflict'}]);
    expect((await ok('oc_get_contact_state', {thingId:a})).peopleState.payload.tag).toBe('first');
    expect((await ok('oc_get_contact_state', {thingId:b})).peopleState.payload.tag).toBe('second');
    await ok('oc_add_private_note', {subjectKind:'user',subjectId:other,text:'Synthetic OpenChat account note'});
    const principal = await graph.privateReviewPrincipal(owner);
    const db = driver.session();
    let accountThing: string;
    try {
      const refs = await db.run(`MATCH (r:OverlayRef {ownerKey:$ownerKey,ref:$ref})-[:REF_OF]->(e:OverlayEntity) RETURN e.id AS id`,
        {ownerKey:principal.ownerKey,ref:`openchat:user:${other}`});
      accountThing = refs.records[0]!.get('id');
    } finally { await db.close(); }
    expect((await ok('oc_merge_people', {merges:[merge([a,accountThing],'account-refusal')]})).results).toEqual([{index:0,error:'merge_account'}]);
    const foreignRead = await call('oc_get_contact_state', {thingId:a}, {owner:other});
    expect(foreignRead).toMatchObject({isError:true,data:{code:'not_found'}});
    expect((await ok('oc_list_merge_events', {thingId:a})).events).toEqual([]);
  });
});
