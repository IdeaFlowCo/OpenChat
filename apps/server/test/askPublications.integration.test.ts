import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
const uri = process.env.NEO4J_TEST_URI, user = process.env.NEO4J_TEST_USER, password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;
integration('durable ask publication: exact snapshot, audience ACL and revocation', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [owner, vlad, stranger] = ['publication-owner','publication-vlad','publication-stranger'].map(value => `${value}-${suffix}`) as [string,string,string];
  let driver: Driver, graph: typeof import('../src/services/privateGraph.js'), app: ReturnType<typeof express>;
  let ids: string[], publicId: string, selectedId: string, selectedRequest: Record<string, unknown>;
  const token = (id: string) => jwt.sign({ userId:id, email:`${id}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me');
  const http = (method: 'get'|'post'|'delete', path: string, actor?: string, body?: unknown) => { const req = request(app)[method](path); if (actor) req.set('Authorization', `Bearer ${token(actor)}`); return body === undefined ? req : req.send(body); };
  const publish = async (askId: string, requestId: string, text: string, audience: unknown) => {
    const body = { requestId, expectedAskRevision:0, expectedPublicationRevision:null, text, audience, confirm:false };
    const preview = await http('post', `/api/private/asks/${askId}/publication`, owner, body);
    expect(preview.status).toBe(200); expect(preview.body.approvalRequired).toBe(true);
    const commit = { ...body, confirm:true, approvalGrant:preview.body.approvalGrant };
    const result = await http('post', `/api/private/asks/${askId}/publication`, owner, commit);
    expect(result.status).toBe(200); expect(result.body.publication.state).toBe('active');
    return { publication:result.body.publication, commit };
  };
  beforeAll(async () => {
    expect(uri).toMatch(/^bolt:\/\/(localhost|127\.0\.0\.1):\d+$/);
    process.env.NEO4J_URI=uri!; process.env.NEO4J_USER=user!; process.env.NEO4J_PASSWORD=password!;
    graph = await import('../src/services/privateGraph.js'); await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const db = driver.session(); try { await db.run('UNWIND $ids AS id CREATE (:User {id:id,name:id})', { ids:[owner,vlad,stranger] }); } finally { await db.close(); }
    app = express().use(express.json());
    app.use('/api/private', (await import('../src/routes/privateGraph.js')).default);
    app.use('/api', (await import('../src/routes/askPublications.js')).default);
    ids = await Promise.all([
      { text:'Find a marketing person for example.test', exposure:'public' },
      { text:'Find awesome people for a matchmaking party' },
      { text:'VC introductions this month for a fundraise' },
    ].map(async fields => (await graph.saveAsk(owner, { author:'self', ...fields, evidence:{ quote:'PRIVATE EVIDENCE MUST NEVER LEAK' } })).ask.id));
  });
  afterAll(async () => {
    const db=driver.session(); try { for (const id of [owner,vlad,stranger]) await db.executeWrite(tx=>graph.deletePrivateGraphForUser(tx,id)); await db.run('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u', { ids:[owner,vlad,stranger] }); } finally { await db.close(); }
    await driver.close(); await (await import('../src/db.js')).getDriver().close();
  });
  it('saving exposure public grants no access; owner sees all three and ordinary readers see no private inventory', async () => {
    expect((await graph.listAsks(owner,{status:'all'})).asks).toHaveLength(3);
    expect((await http('get', `/api/people/${owner}/ask-publications`)).body.publications).toEqual([]);
    expect((await http('get', `/api/private/asks/${ids[0]}`,vlad)).status).toBe(404);
    expect((await http('get','/api/ask-publications/shared-with-me')).status).toBe(401);
    expect((await request(app).get(`/api/people/${owner}/ask-publications`).set('Authorization','Bearer invalid')).status).toBe(401);
  });
  it('requires payload-bound actor approval, then publishes public and Vlad-only safe snapshots with no delivery side effects', async () => {
    const base = { requestId:'approval-test', expectedAskRevision:0, expectedPublicationRevision:null, text:'Public marketing excerpt', audience:{kind:'public'}, confirm:false };
    expect((await http('post',`/api/private/asks/${ids[0]}/publication`,owner,{...base,confirm:true})).status).toBe(409);
    const preview = await http('post',`/api/private/asks/${ids[0]}/publication`,owner,base);
    expect((await http('post',`/api/private/asks/${ids[0]}/publication`,owner,{...base,confirm:true,text:'Mutated excerpt',approvalGrant:preview.body.approvalGrant})).status).toBe(409);
    const db=driver.session();
    const sideEffects = async () => (await db.run("MATCH (n) WHERE any(label IN labels(n) WHERE label IN ['Message','Conversation','AgentIntent','Story','AgentStory','Notification']) RETURN count(n) AS count")).records[0]!.get('count').toNumber();
    try {
      const before=await sideEffects();
      const publicResult=await publish(ids[0]!, 'public-marketing','Looking for a marketing person for example.test',{kind:'public'}); publicId=publicResult.publication.id;
      const selected=await publish(ids[1]!, 'selected-party','Looking for matchmaking-party invitees',{kind:'people',targets:[{kind:'openchat_user',id:vlad}]}); selectedId=selected.publication.id; selectedRequest=selected.commit;
      expect(await sideEffects()).toBe(before);
    } finally { await db.close(); }
    const published = await http('get',`/api/ask-publications/${publicId}`);
    expect(published.status).toBe(200); expect(published.headers['cache-control']).toBe('private, no-store');
    expect(Object.keys(published.body.publication).sort()).toEqual(['audience','id','lifecycle','publishedAt','publisher','revision','text','updatedAt']);
    expect(JSON.stringify(published.body)).not.toMatch(/PRIVATE EVIDENCE|ownerKey|askId|recipientKeys|sources|carrier|placements/);
    expect((await graph.listAsks(owner,{status:'all'})).asks.find(ask=>ask.id===ids[0])?.publication).toMatchObject({state:'active',audienceKind:'public'});
  });
  it('owner sees all canonical asks; Vlad sees selected plus public; stranger/anonymous see public only', async () => {
    expect((await graph.listAsks(owner,{status:'all'})).asks).toHaveLength(3);
    expect((await http('get',`/api/people/${owner}/ask-publications`,vlad)).body.publications.map((p:any)=>p.id).sort()).toEqual([publicId,selectedId].sort());
    for (const viewer of [stranger,undefined]) {
      expect((await http('get',`/api/people/${owner}/ask-publications`,viewer)).body.publications.map((p:any)=>p.id)).toEqual([publicId]);
      expect((await http('get',`/api/ask-publications/${selectedId}`,viewer)).status).toBe(404);
    }
    expect((await http('get','/api/ask-publications/shared-with-me',vlad)).body.publications.map((p:any)=>p.id)).toEqual([selectedId]);
    expect((await http('get','/api/ask-publications/shared-with-me',stranger)).body.publications).toEqual([]);
  });
  it('enforces ACLs before pagination; binds cursor to viewer/filter and blocks either direction', async () => {
    const first=await http('get',`/api/people/${owner}/ask-publications?limit=1`,vlad);
    expect(first.body.publications).toHaveLength(1); expect(first.body.nextCursor).toEqual(expect.any(String));
    expect((await http('get',`/api/people/${owner}/ask-publications?cursor=${encodeURIComponent(first.body.nextCursor)}`,stranger)).status).toBe(400);
    const strangerPage=await http('get',`/api/people/${owner}/ask-publications?limit=1`,stranger); expect(strangerPage.body.nextCursor).toBeNull();
    const db=driver.session(); try { await db.run('MATCH (a:User {id:$owner}), (b:User {id:$vlad}) CREATE (b)-[:BLOCKED]->(a)',{owner,vlad});
      expect((await http('get',`/api/ask-publications/${selectedId}`,vlad)).status).toBe(404);
      const retry = await http('post',`/api/private/asks/${ids[1]}/publication`,owner,selectedRequest);
      expect(retry.status).toBe(200); expect(retry.body.replay).toBe(true);
      expect((await http('post',`/api/private/asks/${ids[1]}/publication`,owner,{...selectedRequest,text:'Changed retry'})).status).toBe(409);
      expect((await http('get',`/api/people/${owner}/ask-publications`,vlad)).body.publications).toEqual([]);
      expect((await http('get',`/api/ask-publications/${publicId}`)).status).toBe(200);
      await db.run('MATCH (:User {id:$vlad})-[b:BLOCKED]-(:User {id:$owner}) DELETE b',{owner,vlad});
    } finally { await db.close(); }
  });
  it('private edits never change a published snapshot; revoke denies all later reads and committed retry never reactivates', async () => {
    await graph.updateAsk(owner,ids[1]!,{text:'Private changed party details'});
    expect((await http('get',`/api/ask-publications/${selectedId}`,vlad)).body.publication.text).toBe('Looking for matchmaking-party invitees');
    const ownerRead=await http('get',`/api/private/asks/${ids[1]}/publication`,owner); expect(ownerRead.body.publishedVersionDiffers).toBe(true);
    expect(ownerRead.body.recipients).toEqual([{userId:vlad,displayName:vlad}]);
    const revoked=await http('delete',`/api/private/asks/${ids[1]}/publication`,owner,{expectedPublicationRevision:ownerRead.body.publication.revision}); expect(revoked.status).toBe(200);
    expect((await http('get',`/api/ask-publications/${selectedId}`,vlad)).status).toBe(404);
    expect((await http('get','/api/ask-publications/shared-with-me',vlad)).body.publications).toEqual([]);
    const replay=await http('post',`/api/private/asks/${ids[1]}/publication`,owner,selectedRequest); expect(replay.status).toBe(200); expect(replay.body.publication.state).toBe('revoked');
    expect((await graph.getAsk(owner,ids[1]!)).text).toBe('Private changed party details');
    await graph.updateAsk(owner,ids[0]!,{status:'withdrawn'}); expect((await http('get',`/api/ask-publications/${publicId}`)).status).toBe(404);
  });
});
