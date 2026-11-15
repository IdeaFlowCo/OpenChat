import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readContactState:vi.fn(), importContactSource: vi.fn(), importContactSources: vi.fn(), savePeopleState: vi.fn(), addLink: vi.fn(), addNote: vi.fn(), createPrivateThing: vi.fn(), deleteLink: vi.fn(), deleteNote: vi.fn(), deletePrivateThing: vi.fn(), getPersonOverlay: vi.fn(), getThing: vi.fn(),
  listDue: vi.fn(), listThings: vi.fn(), updateNote: vi.fn(), updatePersonCard: vi.fn(), updateLink: vi.fn(), searchPrivate: vi.fn(), getNeighbourhood: vi.fn(),
  updatePrivateThing: vi.fn(), mergePeople: vi.fn(),
}));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, ...mocks };
});
import privateGraphRoutes, { privateGraphBody } from '../src/routes/privateGraph.js';
import { PrivateGraphError } from '../src/services/privateGraph.js';

describe('private graph routes', () => {
  let server: Server;
  let baseUrl: string;
  const token = () => `Bearer ${jwt.sign({ userId: 'alice', email: 'alice@example.test' }, process.env.JWT_SECRET!)}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}/api/private${path}`, { ...init, headers: { Authorization: token(), 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'private-graph-route-test-secret';
    const app = express();
    app.use(privateGraphBody);
    app.use(express.json());
    app.use('/api/private', privateGraphRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('requires sign-in on every route', async () => {
    for (const [method, path] of [['POST','/contact-sources'],['POST','/contact-source-batches'],['PUT','/things/t1/people-state'],['GET','/things/t1/contact-state'],['GET', '/due'], ['GET', '/people/bob'], ['PATCH', '/people/bob'], ['POST', '/people/bob/notes'], ['POST', '/people/bob/links'], ['GET', '/things'], ['POST', '/things'], ['GET', '/things/t1'], ['POST', '/things/t1/notes'], ['POST', '/things/t1/links'], ['PATCH', '/notes/n1'], ['DELETE', '/notes/n1'], ['DELETE', '/links/l1'], ['DELETE', '/things/t1'], ['PATCH', '/things/t1']]) {
      expect((await fetch(`${baseUrl}/api/private${path}`, { method })).status, `${method} ${path}`).toBe(401);
    }
    expect(Object.values(mocks).every(mock => mock.mock.calls.length === 0)).toBe(true);
  });

  it('source and state writes use authenticated owner and actor attribution',async()=>{
    mocks.importContactSources.mockResolvedValue({results:[{index:0,id:'private-person'}]});
    const cards=[{source:'synthetic:book',sourceId:'one',name:'Synthetic',data:{schemaVersion:1}}];
    expect((await call('/contact-source-batches',{method:'POST',body:JSON.stringify({cards,ownerId:'mallory'})})).status).toBe(200);
    expect(mocks.importContactSources).toHaveBeenCalledWith('alice',cards,{author:'owner',source:'app',assertion:'stated'},'openchat:owner');
    mocks.savePeopleState.mockResolvedValue({revision:1});
    const state={expectedRevision:0,payload:{schemaVersion:1}};
    expect((await call('/things/t1/people-state',{method:'PUT',body:JSON.stringify(state)})).status).toBe(200);
    expect(mocks.savePeopleState).toHaveBeenCalledWith('alice','t1',state,{author:'owner',source:'app',assertion:'stated'},'openchat:owner');
  });

  it('accepts supported large source cards, full batches and People state', async () => {
    const card = {source:'synthetic:book',sourceId:'one',name:'Synthetic',data:{schemaVersion:1,note:'x'.repeat(260000)}};
    mocks.importContactSource.mockResolvedValue({created:true});
    expect((await call('/contact-sources', {method:'POST',body:JSON.stringify(card)})).status).toBe(200);
    expect(mocks.importContactSource).toHaveBeenCalledWith('alice',card,{author:'owner',source:'app',assertion:'stated'},'openchat:owner');
    const cards = Array.from({length:25}, (_, index) => ({...card,sourceId:String(index)}));
    mocks.importContactSources.mockResolvedValue({results:[]});
    expect((await call('/contact-source-batches', {method:'POST',body:JSON.stringify({cards})})).status).toBe(200);
    expect(mocks.importContactSources).toHaveBeenCalledWith('alice',cards,{author:'owner',source:'app',assertion:'stated'},'openchat:owner');
    const state = {operationId:'large-state',expectedRevision:0,payload:card.data};
    mocks.savePeopleState.mockResolvedValue({revision:1});
    expect((await call('/things/t1/people-state', {method:'PUT',body:JSON.stringify(state)})).status).toBe(200);
    expect(mocks.savePeopleState).toHaveBeenCalledWith('alice','t1',state,{author:'owner',source:'app',assertion:'stated'},'openchat:owner');
  });

  it('bounds large bodies without increasing limits on other routes', async () => {
    const largeBody = JSON.stringify({note:'x'.repeat(1024 * 1024)});
    expect((await call('/contact-sources', {method:'POST',body:largeBody})).status).toBe(413);
    expect((await call('/merges', {method:'POST',body:largeBody})).status).toBe(413);
    expect((await call('/things/t1/people-state', {method:'PUT',body:largeBody})).status).toBe(413);
    expect((await call('/contact-source-batches', {method:'POST',body:JSON.stringify({note:'x'.repeat(7 * 1024 * 1024)})})).status).toBe(413);
    expect((await call('/things', {method:'POST',body:JSON.stringify({note:'x'.repeat(120000)})})).status).toBe(413);
    expect(mocks.importContactSource).not.toHaveBeenCalled();
    expect(mocks.importContactSources).not.toHaveBeenCalled();
    expect(mocks.savePeopleState).not.toHaveBeenCalled();
    expect(mocks.createPrivateThing).not.toHaveBeenCalled();
    expect(mocks.mergePeople).not.toHaveBeenCalled();
  });
  it('accepts a full merge batch with maximum-length evidence through the bounded parser', async () => {
    const merges = Array.from({length:25}, (_, index) => ({
      ids:[`person-head-${index}`,`person-member-${index}`],
      rule:'exact-email', operationId:`large-merge-${index}`,
      evidence:Array.from({length:40}, (_, evidenceIndex) => `${evidenceIndex}:`.padEnd(300, 'x')),
    }));
    const results = merges.map((_, index) => ({index,headId:`person-head-${index}`}));
    mocks.mergePeople.mockResolvedValue({results});
    const response = await call('/merges/', {method:'POST',body:JSON.stringify({merges,batchId:'large-batch'})});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({results});
    expect(mocks.mergePeople).toHaveBeenCalledWith('alice',merges,'large-batch',{author:'owner',source:'app',assertion:'stated'},'openchat:owner');
  });
  it('forwards the lightweight summary projection with all pagination arguments', async () => {
    const page = {things:[],total:0,nextCursor:null};
    mocks.listThings.mockResolvedValue(page);
    const response = await call('/things?kind=person&summary=true&limit=100&after=next');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(mocks.listThings).toHaveBeenCalledWith('alice',undefined,'person',{summary:'true',limit:'100',after:'next',details:undefined});
  });
  it('always acts for the signed-in owner, whatever the request body claims', async () => {
    mocks.getPersonOverlay.mockResolvedValue({ userId: 'bob', card: {}, notes: [], links: [] });
    mocks.addNote.mockResolvedValue({ id: 'n1', text: 'hi' });
    mocks.updatePersonCard.mockResolvedValue({ important: true });
    mocks.addLink.mockResolvedValue({ id: 'l1' });
    expect((await call('/people/bob')).status).toBe(200);
    expect(mocks.getPersonOverlay).toHaveBeenCalledWith('alice', 'bob');
    expect((await call('/people/bob/notes', { method: 'POST', body: JSON.stringify({ text: 'hi', ownerId: 'mallory' }) })).status).toBe(201);
    expect(mocks.addNote).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, 'hi', { author: 'owner', source: 'app', assertion: 'stated' });
    expect((await call('/people/bob', { method: 'PATCH', body: JSON.stringify({ important: true, ownerId: 'mallory' }) })).status).toBe(200);
    expect(mocks.updatePersonCard).toHaveBeenCalledWith('alice', 'bob', { important: true }, { author: 'owner', source: 'app', assertion: 'stated' },'openchat:owner');
    expect((await call('/people/bob', { method: 'PATCH', body: JSON.stringify({ ownerId: 'mallory' }) })).status).toBe(400);
    expect(mocks.updatePersonCard).toHaveBeenCalledTimes(1);
    expect((await call('/things/t1/links', { method: 'POST', body: JSON.stringify({ relation: 'part of', to: { kind: 'project', name: 'Atlas' } }) })).status).toBe(201);
    expect(mocks.addLink).toHaveBeenCalledWith('alice', { kind: 'thing', id: 't1' }, 'part of', { kind: 'project', name: 'Atlas' }, { author: 'owner', source: 'app', assertion: 'stated' }, {});
  });

  it('records the signed-in owner as author whatever the body claims', async () => {
    mocks.addLink.mockResolvedValue({ id: 'l1' });
    expect((await call('/people/bob/links', { method: 'POST', body: JSON.stringify({ relation: 'knows', to: { kind: 'user', id: 'carol' }, author: 'agent:Spoof', source: 'connector', assertion: 'inferred' }) })).status).toBe(201);
    expect(mocks.addLink).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, 'knows', { kind: 'user', id: 'carol' }, { author: 'owner', source: 'app', assertion: 'stated' }, {});
  });

  it('passes a new link\'s relationType, since, until and context, and only those', async () => {
    mocks.addLink.mockResolvedValue({ id: 'l2' });
    const body = { relation: 'old flame', to: { kind: 'user', id: 'carol' }, relationType: 'knows', since: '2019', until: null, context: 'AGI House', colour: 'red' };
    expect((await call('/people/bob/links', { method: 'POST', body: JSON.stringify(body) })).status).toBe(201);
    expect(mocks.addLink).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, 'old flame', { kind: 'user', id: 'carol' }, { author: 'owner', source: 'app', assertion: 'stated' }, { relationType: 'knows', since: '2019', until: null, context: 'AGI House' });
  });

  it('edits a relation, searches and reads a neighbourhood for the signed-in owner only', async () => {
    mocks.updateLink.mockResolvedValue({ link: { id: 'l1', relation: 'cousin of' }, merged: false });
    const edited = await call('/links/l1', { method: 'PATCH', body: JSON.stringify({ relation: 'cousin of', ownerId: 'mallory' }) });
    expect([edited.status, await edited.json()]).toEqual([200, { link: { id: 'l1', relation: 'cousin of' }, merged: false }]);
    expect(mocks.updateLink).toHaveBeenCalledWith('alice', 'l1', { relation: 'cousin of' }, { author: 'owner', source: 'app', assertion: 'stated' });
    await call('/links/l1', { method: 'PATCH', body: JSON.stringify({ assertion: 'inferred', context: null, author: 'agent:Spoof' }) });
    expect(mocks.updateLink).toHaveBeenLastCalledWith('alice', 'l1', { assertion: 'inferred', context: null }, { author: 'owner', source: 'app', assertion: 'stated' });

    mocks.searchPrivate.mockResolvedValue({ things: [], links: [], truncated: false });
    expect((await call('/search?q=maya&relationType=family&kind=person&limit=5')).status).toBe(200);
    expect(mocks.searchPrivate).toHaveBeenCalledWith('alice', { q: 'maya', relationType: 'family', kind: 'person', limit: '5' });

    mocks.getNeighbourhood.mockResolvedValue({ center: { kind: 'user', id: 'bob', name: 'Bob' }, depth: 2, nodes: [], links: [], truncated: false });
    expect((await call('/neighbourhood?subjectKind=user&subjectId=bob&depth=2')).status).toBe(200);
    expect(mocks.getNeighbourhood).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, '2');
    for (const bad of ['/neighbourhood', '/neighbourhood?subjectKind=planet&subjectId=x', '/neighbourhood?subjectKind=user']) expect((await call(bad)).status, bad).toBe(400);
    expect(mocks.getNeighbourhood).toHaveBeenCalledTimes(1);
    for (const [method, path] of [['PATCH', '/links/l1'], ['GET', '/search'], ['GET', '/neighbourhood']]) expect((await fetch(`${baseUrl}/api/private${path}`, { method })).status, `${method} ${path}`).toBe(401);
  });

  it('creates a saved person only for the signed-in owner without account binding', async () => {
    mocks.createPrivateThing.mockResolvedValue({id:'saved-person',kind:'person',name:'Chet'});
    const response = await call('/things', {method:'POST',body:JSON.stringify({kind:'person',name:'Chet',ownerId:'mallory',userId:'other-account'})});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({id:'saved-person',kind:'person',name:'Chet'});
    expect(mocks.createPrivateThing).toHaveBeenCalledWith('alice','person','Chet',undefined);
  });

  it('edits a saved thing only for the signed-in owner', async () => {
    mocks.updatePrivateThing.mockResolvedValue({ id: 't1', kind: 'project', name: 'Bloomscroll', description: 'a feed that nudges you into coherence' });
    const response = await call('/things/t1', { method: 'PATCH', body: JSON.stringify({ kind: 'project', description: 'a feed that nudges you into coherence' }) });
    expect([response.status, (await response.json()).kind]).toEqual([200, 'project']);
    expect(mocks.updatePrivateThing).toHaveBeenCalledWith('alice', 't1', { kind: 'project', description: 'a feed that nudges you into coherence' });
    mocks.updatePrivateThing.mockRejectedValueOnce(new PrivateGraphError(404, 'Not found'));
    expect((await call('/things/someone-elses', { method: 'PATCH', body: JSON.stringify({ description: 'x' }) })).status).toBe(404);
  });

  it('deletes a saved thing only for the signed-in owner, and reports a missing one as not found', async () => {
    mocks.deletePrivateThing.mockResolvedValueOnce({ deleted: true, id: 't1', notesRemoved: 2, linksRemoved: 1 });
    const response = await call('/things/t1', { method: 'DELETE', body: JSON.stringify({ ownerId: 'mallory' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, id: 't1', notesRemoved: 2, linksRemoved: 1 });
    expect(mocks.deletePrivateThing).toHaveBeenCalledWith('alice', 't1');
    mocks.deletePrivateThing.mockRejectedValueOnce(new PrivateGraphError(404, 'Not found'));
    const again = await call('/things/t1', { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: 'Not found' });
  });

  it('reports a missing or unavailable person as not found, never as a sign-in failure', async () => {
    mocks.getPersonOverlay.mockRejectedValue(new PrivateGraphError(404, 'Person unavailable'));
    const response = await call('/people/blocked');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Person unavailable' });
    mocks.deleteNote.mockRejectedValue(new Error('bolt: password=secret'));
    const failed = await call('/notes/n1', { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
  });
});
