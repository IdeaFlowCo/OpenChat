import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { OverlayStore } from '../src/services/overlay/store.js';
import { ownerKeyFor } from '../src/services/overlay/contract.js';

const uri = process.env.NEO4J_TEST_URI, user = process.env.NEO4J_TEST_USER, password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;
const by = { author:'agent:Synthetic owner test', source:'connector', assertion:'stated' } as const;
const card = (id:string) => ({source:'synthetic:owner-fence',sourceId:id,name:'Independent source name',data:{schemaVersion:1,future:{retained:id}}});

function barrier() {
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  return { release, ready, pause:async () => { reached(); await held; } };
}

integration('contact owner lifecycle transactions', {timeout:30000}, () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids:string[] = [];
  let driver:Driver, graph:typeof import('../src/services/privateGraph.js');
  beforeAll(async () => {
    process.env.NEO4J_URI=uri!; process.env.NEO4J_USER=user!; process.env.NEO4J_PASSWORD=password!;
    graph = await import('../src/services/privateGraph.js');
    await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!,neo4j.auth.basic(user!,password!));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (!driver) return;
    const db = driver.session();
    try {
      for (const id of ids) await db.executeWrite(tx => graph.deletePrivateGraphForUser(tx,id));
      await db.run('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u',{ids});
    } finally { await db.close(); }
    await driver.close();
    await (await import('../src/db.js')).getDriver().close();
  });
  async function fixture(label:string) {
    const id = `${label}-${suffix}`;
    ids.push(id);
    const db = driver.session();
    try { await db.run('CREATE (:User {id:$id,name:$id})',{id}); }
    finally { await db.close(); }
    return id;
  }

  it.each(['delete','rebind'])('stops a batch after owner %s between durable per-card commits', async change => {
    const owner = await fixture(`batch-${change}`), unrelated = await fixture(`unrelated-${change}`);
    const principal = await graph.privateReviewPrincipal(owner);
    await graph.importContactSource(unrelated,card(`unrelated-${change}`),by,'grant:unrelated');
    const unrelatedBefore = await graph.exportPrivateGraph(unrelated);
    const gate = barrier(), original = OverlayStore.prototype.importContact;
    let completed = 0;
    vi.spyOn(OverlayStore.prototype,'importContact').mockImplementation(async function (...args) {
      const result = await original.apply(this,args);
      if (++completed === 1) await gate.pause();
      return result;
    });
    const pending = graph.importContactSources(owner,[card(`first-${change}`),card(`second-${change}`),card(`third-${change}`)],by,'grant:batch')
      .then(result => ({result}),error => ({error}));
    const db = driver.session();
    try {
      await Promise.race([gate.ready,pending.then(() => { throw new Error('Batch did not reach its first committed card'); })]);
      const first = (await graph.listThings(owner,'','person')).things[0]!;
      expect((await graph.readContactState(owner,first.id)).contactSources[0]).toMatchObject({data:card(`first-${change}`).data,provenance:{actorId:'grant:batch'}});
      if (change === 'delete') await db.executeWrite(async tx => {
        await graph.deletePrivateGraphForUser(tx,owner);
        await tx.run('MATCH (u:User {id:$owner}) DETACH DELETE u',{owner});
      });
      else await db.run('MATCH (u:User {id:$owner}) SET u.ideaflowIssuer=$issuer,u.ideaflowSub=$owner',{owner,issuer:'https://synthetic-owner.test'});
      gate.release();
      const outcome = await pending;
      expect(outcome).toMatchObject({error:{status:change === 'delete' ? 404 : 409,details:{code:change === 'delete' ? 'contact_owner_unavailable' : 'contact_owner_changed',index:1,results:[{index:0,id:first.id,created:true,unchanged:false}]}}});
      expect(completed).toBe(1);
      const sources = await db.run('MATCH (s:OverlayContactSource {ownerKey:$ownerKey}) RETURN s.sourceId AS sourceId',{ownerKey:principal.ownerKey});
      expect(sources.records.map(row => row.get('sourceId'))).toEqual(change === 'delete' ? [] : [`first-${change}`]);
      if (change === 'delete') {
        const remnants = await db.run('MATCH (n {ownerKey:$ownerKey}) RETURN count(n) AS total',{ownerKey:principal.ownerKey});
        expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
      }
      expect(await graph.exportPrivateGraph(unrelated)).toEqual(unrelatedBefore);
    } finally { gate.release(); await pending; await db.close(); }
  });

  it.each(['source','state','card'].flatMap(write => ['delete','rebind'].map(change => ({write,change}))))('revalidates $write owner after resolution and before its transaction on $change', async ({write,change}) => {
    const owner = await fixture(`${write}-${change}`), subject = await fixture(`${write}-${change}-person`);
    const {principal,entityId} = await graph.privateReviewSubject(owner,{kind:'user',id:subject});
    const before = await graph.readContactState(owner,entityId), gate = barrier();
    const source = OverlayStore.prototype.importContact, state = OverlayStore.prototype.savePeopleState, update = OverlayStore.prototype.update;
    if (write === 'source') vi.spyOn(OverlayStore.prototype,'importContact').mockImplementation(async function (...args) { await gate.pause(); return source.apply(this,args); });
    if (write === 'state') vi.spyOn(OverlayStore.prototype,'savePeopleState').mockImplementation(async function (...args) { await gate.pause(); return state.apply(this,args); });
    if (write === 'card') vi.spyOn(OverlayStore.prototype,'update').mockImplementation(async function (...args) { await gate.pause(); return update.apply(this,args); });
    const operation = write === 'source' ? graph.importContactSource(owner,{...card(`${write}-${change}`),entityId},by,'grant:paused')
      : write === 'state' ? graph.savePeopleState(owner,entityId,{operationId:'paused',expectedRevision:0,payload:{schemaVersion:1,opaque:{retained:true}}},by,'grant:paused')
      : graph.updatePersonCard(owner,subject,{important:true},by,'grant:paused');
    const pending = operation.then(result => ({result}),error => ({error}));
    const db = driver.session();
    try {
      await Promise.race([gate.ready,pending.then(() => { throw new Error('Write did not reach its transaction barrier'); })]);
      if (change === 'delete') await db.executeWrite(async tx => {
        await graph.deletePrivateGraphForUser(tx,owner);
        await tx.run('MATCH (u:User {id:$owner}) DETACH DELETE u',{owner});
      });
      else await db.run('MATCH (u:User {id:$owner}) SET u.ideaflowIssuer=$issuer,u.ideaflowSub=$owner',{owner,issuer:'https://synthetic-owner.test'});
      gate.release();
      expect(await pending).toMatchObject({error:{status:change === 'delete' ? 404 : 409,details:{code:change === 'delete' ? 'contact_owner_unavailable' : 'contact_owner_changed'}}});
      if (change === 'delete') {
        const remnants = await db.run('MATCH (n {ownerKey:$ownerKey}) RETURN count(n) AS total',{ownerKey:principal.ownerKey});
        expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
      } else {
        const canonical = new OverlayStore(driver,process.env.NEO4J_DATABASE || 'neo4j');
        await canonical.initialize();
        const unchanged = await canonical.get(principal,entityId);
        expect(unchanged.card).toEqual(before.card);
        expect(unchanged.peopleState).toEqual(before.peopleState);
        expect(unchanged.contactSources).toEqual(before.contactSources);
        const wrongOwner = await db.run('MATCH (n {ownerKey:$ownerKey}) RETURN count(n) AS total',{ownerKey:ownerKeyFor('https://synthetic-owner.test',owner)});
        expect(wrongOwner.records[0]!.get('total').toNumber()).toBe(0);
      }
    } finally { gate.release(); await pending; await db.close(); }
  });

  it('keeps ordinary record refusals and durable replay receipts in a live owner batch', async () => {
    const owner = await fixture('batch-replay'), imported = card('durable-replay');
    const first = await graph.importContactSources(owner,[imported,{...imported,name:''}],by,'grant:one');
    expect(first.results).toEqual([{index:0,id:expect.any(String),created:true,unchanged:false},{index:1,error:'invalid_name'}]);
    expect((await graph.importContactSources(owner,[imported],by,'grant:one')).results).toEqual([{index:0,id:first.results[0]!.id,created:false,unchanged:true}]);
    const state = await graph.readContactState(owner,String(first.results[0]!.id));
    expect(state.contactSources).toHaveLength(1);
    expect(state.contactSources[0]).toMatchObject({data:imported.data,provenance:{actorId:'grant:one'}});
  });
});
