import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { OverlayStore } from '../src/services/overlay/store.js';
const extraction = vi.hoisted(() => vi.fn());
const interleaving = vi.hoisted(() => ({ afterSubject: null as null | (() => Promise<void>) }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: extraction }; } }));
vi.mock('../src/services/privateGraph.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/privateGraph.js')>();
  return { ...actual, privateReviewSubject: async (...args: Parameters<typeof actual.privateReviewSubject>) => {
    const result = await actual.privateReviewSubject(...args);
    const hook = interleaving.afterSubject;
    interleaving.afterSubject = null;
    await hook?.();
    return result;
  } };
});
const uri = process.env.NEO4J_TEST_URI, user = process.env.NEO4J_TEST_USER, password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;
integration('private note review transaction integration', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids = ['review-owner','review-person','review-other'].map(s => `${s}-${suffix}`);
  const [owner,person,other] = ids as [string,string,string];
  let driver: Driver, graph: typeof import('../src/services/privateGraph.js'), review: typeof import('../src/services/privateNoteReview.js');
  beforeAll(async () => {
    process.env.NEO4J_URI=uri!; process.env.NEO4J_USER=user!; process.env.NEO4J_PASSWORD=password!;
    graph = await import('../src/services/privateGraph.js'); review = await import('../src/services/privateNoteReview.js');
    await graph.ensurePrivateGraphIndexes(); driver = neo4j.driver(uri!,neo4j.auth.basic(user!,password!));
    const db=driver.session(); try { await db.run('UNWIND $ids AS id CREATE (:User {id:id,name:id})',{ids}); } finally {await db.close();}
  });
  afterAll(async () => {
    if (!driver) return;
    const db=driver.session(); try { for (const id of ids) await db.executeWrite(tx=>graph.deletePrivateGraphForUser(tx,id)); await db.run('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u',{ids}); } finally {await db.close();}
    await driver.close(); await (await import('../src/db.js')).getDriver().close();
  });
  afterEach(() => { vi.unstubAllEnvs(); extraction.mockReset(); interleaving.afterSubject = null; });
  async function seedReady(text: string, key: string) {
    const batch=await review.captureNoteReview(owner,{kind:'user',id:person},{text,requestId:key});
    batch.status='ready'; batch.suggestions=[{id:'ask-one',kind:'ask',text:'Meet local founders',evidence:text},{id:'link-one',kind:'connection',text:'Works at Acme',relation:'works at',target:{kind:'company',name:`Acme-${suffix}`},evidence:text}];
    const principal=await graph.privateReviewPrincipal(owner), db=driver.session();
    try {await db.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload',{id:batch.id,ownerKey:principal.ownerKey,payload:JSON.stringify(batch)});} finally {await db.close();}
    return batch;
  }
  it('concurrent request retry saves exactly one note and one durable ledger', async () => {
    const captures=await Promise.all(Array.from({length:3},()=>review.captureNoteReview(owner,{kind:'user',id:person},{text:'Original rough note',requestId:'retry-one'})));
    expect(new Set(captures.map(r=>r.id)).size).toBe(1);
    expect((await graph.getPersonOverlay(owner,person)).notes.filter(n=>n.text==='Original rough note')).toHaveLength(1);
  });
  it('manual standing asks are ready immediately without a provider and retry conflicts include capture mode', async () => {
    const batch=await review.captureNoteReview(owner,{kind:'user',id:person},{text:'Find a local editor',requestId:'manual-ask',asStandingAsk:true});
    expect(batch.status).toBe('ready'); expect(batch.suggestions).toHaveLength(1);
    expect(batch.suggestions[0]).toMatchObject({kind:'ask',text:'Find a local editor',evidence:'Find a local editor'});
    expect(await review.suggestNoteReview(owner,batch.id)).toEqual(batch);
    await expect(review.captureNoteReview(owner,{kind:'user',id:person},{text:'Find a local editor',requestId:'manual-ask'})).rejects.toMatchObject({status:409});
    const applied=await review.applyNoteReview(owner,batch.id,{suggestionIds:[batch.suggestions[0]!.id]});
    expect(applied.createdRecords).toHaveLength(1);
    await review.undoNoteReview(owner,batch.id);
  });
  it('preserves merged review history, capture receipts and source availability through split', async () => {
    const head = await graph.createPrivateThing(owner,'person',`Review head ${suffix}`);
    const member = await graph.createPrivateThing(owner,'person',`Review member ${suffix}`);
    const headSubject = {kind:'thing',id:head.id} as const;
    const memberSubject = {kind:'thing',id:member.id} as const;
    const headInput = {text:'Find a synthetic editor',requestId:'merge-review-retry',asStandingAsk:true};
    const memberInput = {...headInput,text:'Find a synthetic guide'};
    const headReview = await review.captureNoteReview(owner,headSubject,headInput);
    const memberReview = await review.captureNoteReview(owner,memberSubject,memberInput);
    const applied = await review.applyNoteReview(owner,memberReview.id,{suggestionIds:[memberReview.suggestions[0]!.id]});
    const foreign = await graph.createPrivateThing(other,'person',`Foreign review ${suffix}`);
    const foreignReview = await review.captureNoteReview(other,{kind:'thing',id:foreign.id},memberInput);
    const by = {author:'owner',source:'app',assertion:'stated'} as const;
    await graph.mergePeople(owner,[{ids:[head.id,member.id],headId:head.id,rule:'synthetic-review',operationId:'merge-review-history'}],undefined,by);
    const db = driver.session();
    try {
      await db.run('MATCH (e:OverlayEntity {id:$id}) SET e.mergedInto=$head', {id:foreign.id,head:head.id});
    } finally { await db.close(); }
    for (const subject of [headSubject,memberSubject]) {
      const history = await review.listNoteReviews(owner,subject);
      expect(history.reviews).toHaveLength(2);
      expect(history.reviews).toContainEqual({...headReview,sourceNoteAvailable:true});
      expect(history.reviews).toContainEqual({...applied,sourceNoteAvailable:true});
      expect(history.reviews.some(row => row.id === foreignReview.id)).toBe(false);
      expect(history.asks).toContainEqual(expect.objectContaining({id:applied.createdRecords![0]!.id,reviewId:memberReview.id}));
      const ownInput = subject.id === head.id ? headInput : memberInput;
      expect(await review.captureNoteReview(owner,subject,ownInput)).toEqual(subject.id === head.id ? headReview : applied);
      await expect(review.captureNoteReview(owner,subject,subject.id === head.id ? memberInput : headInput)).rejects.toMatchObject({status:409});
      await expect(review.captureNoteReview(owner,subject,{...memberInput,text:'Different synthetic note'})).rejects.toMatchObject({status:409});
    }
    expect((await graph.getThing(owner,head.id)).notes).toHaveLength(2);
    await graph.deleteNote(owner,headReview.note.id);
    const history = await review.listNoteReviews(owner,headSubject);
    expect(history.reviews.find(row => row.id === headReview.id)?.sourceNoteAvailable).toBe(false);
    expect(history.reviews.find(row => row.id === memberReview.id)?.sourceNoteAvailable).toBe(true);
    expect((await review.undoNoteReview(owner,memberReview.id)).status).toBe('undone');
    await graph.splitPerson(owner,{id:member.id,operationId:'split-review-history'},by);
    expect((await review.listNoteReviews(owner,headSubject)).reviews.map(row => row.id)).toEqual([headReview.id]);
    expect((await review.listNoteReviews(owner,memberSubject)).reviews).toEqual([{...applied,status:'undone',sourceNoteAvailable:true}]);
  });
  it('replays exact merged receipts and otherwise the oldest receipt', async () => {
    const people = await Promise.all(['head','older','newer'].map(name => graph.createPrivateThing(owner,'person',`Receipt ${name} ${suffix}`)));
    const [head,older,newer] = people;
    const input = {text:'Find a synthetic receipt editor',requestId:'identical-merged-receipts',asStandingAsk:true};
    const olderReview = await review.captureNoteReview(owner,{kind:'thing',id:older!.id},input);
    const newerReview = await review.captureNoteReview(owner,{kind:'thing',id:newer!.id},input);
    const applied = await review.applyNoteReview(owner,newerReview.id,{suggestionIds:[newerReview.suggestions[0]!.id]});
    olderReview.createdAt = '2026-01-01T00:00:00.000Z';
    applied.createdAt = '2026-02-01T00:00:00.000Z';
    const db = driver.session();
    try {
      for (const receipt of [olderReview,applied]) await db.run('MATCH (r:OpenChatNoteReview {id:$id}) SET r.payload=$payload', {id:receipt.id,payload:JSON.stringify(receipt)});
    } finally { await db.close(); }
    await graph.mergePeople(owner,[{ids:people.map(person => person.id),headId:head!.id,rule:'synthetic-receipts',operationId:'identical-merge-receipts'}],undefined,{author:'owner',source:'app',assertion:'stated'});
    expect(await review.captureNoteReview(owner,{kind:'thing',id:older!.id},input)).toEqual(olderReview);
    expect(await review.captureNoteReview(owner,{kind:'thing',id:newer!.id},input)).toEqual(applied);
    expect(await review.captureNoteReview(owner,{kind:'thing',id:head!.id},input)).toEqual(olderReview);
    await review.undoNoteReview(owner,applied.id);
  });
  it('keeps a capture on its current head when a merge follows subject resolution', async () => {
    const head = await graph.createPrivateThing(owner,'person',`Racing head ${suffix}`);
    const member = await graph.createPrivateThing(owner,'person',`Racing member ${suffix}`);
    const by = {author:'owner',source:'app',assertion:'stated'} as const;
    interleaving.afterSubject = async () => {
      await graph.mergePeople(owner,[{ids:[head.id,member.id],headId:head.id,rule:'synthetic-race',operationId:'capture-racing-merge'}],undefined,by);
    };
    const input = {text:'Synthetic capture after merging',requestId:'capture-racing-merge'};
    const captured = await review.captureNoteReview(owner,{kind:'thing',id:member.id},input);
    expect(captured.subject).toEqual({kind:'thing',id:head.id});
    await graph.splitPerson(owner,{id:member.id,operationId:'split-racing-capture'},by);
    expect((await graph.getThing(owner,head.id)).notes).toContainEqual(captured.note);
    expect((await graph.getThing(owner,member.id)).notes).toEqual([]);
    expect((await review.listNoteReviews(owner,{kind:'thing',id:head.id})).reviews).toEqual([{...captured,sourceNoteAvailable:true}]);
    expect((await review.listNoteReviews(owner,{kind:'thing',id:member.id})).reviews).toEqual([]);
    expect(await review.captureNoteReview(owner,{kind:'thing',id:head.id},input)).toEqual(captured);
  });
  it('invalid selected edit rolls back all new records and preserves the note', async () => {
    const batch=await seedReady('A private note','rollback-one');
    await expect(review.applyNoteReview(owner,batch.id,{suggestionIds:['ask-one','link-one'],edits:[{id:'link-one',target:{kind:'invalid',name:'Acme'}}]})).rejects.toMatchObject({status:400});
    expect((await review.listNoteReviews(owner,{kind:'user',id:person})).asks).toHaveLength(0);
    expect((await graph.getPersonOverlay(owner,person)).notes.some(n=>n.id===batch.note.id)).toBe(true);
  });
  it('rolls back an ask created before a later connection failure', async () => {
    const link=await graph.addLink(owner,{kind:'user',id:person},'mentioned',{kind:'project',name:`Rollback-${suffix}`});
    const batch=await review.captureNoteReview(owner,{kind:'thing',id:link.other.id},{text:'Rough project note',requestId:'actual-rollback'});
    batch.status='ready'; batch.suggestions=[{id:'new-ask',kind:'ask',text:'A rolled back ask',evidence:'Rough project note'},{id:'self-link',kind:'connection',text:'Self link rejected',relation:'part of',target:{kind:'project',name:`Rollback-${suffix}`},evidence:'Rough project note'}];
    const principal=await graph.privateReviewPrincipal(owner), db=driver.session();
    try {await db.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload',{id:batch.id,ownerKey:principal.ownerKey,payload:JSON.stringify(batch)});} finally {await db.close();}
    await expect(review.applyNoteReview(owner,batch.id,{suggestionIds:['new-ask','self-link']})).rejects.toMatchObject({status:400});
    const history=await review.listNoteReviews(owner,{kind:'thing',id:link.other.id});
    expect(history.asks).toHaveLength(0); expect(history.reviews[0]!.status).toBe('ready');
    expect((await graph.getThing(owner,link.other.id)).notes[0]!.id).toBe(batch.note.id);
    await graph.deleteLink(owner,link.id);
  });
  it('deduplicates across batches; undo after reload removes only records created by that batch', async () => {
    await graph.addLink(owner,{kind:'user',id:person},'works at',{kind:'company',name:`Acme-${suffix}`});
    const batch=await seedReady('Needs local founders','apply-one');
    const applied=await review.applyNoteReview(owner,batch.id,{suggestionIds:['ask-one','link-one']});
    expect(applied.createdRecords?.map(r=>r.kind)).toEqual(['ask']);
    await expect(review.undoNoteReview(other,batch.id)).rejects.toMatchObject({status:404});
    expect((await review.listNoteReviews(owner,{kind:'user',id:person})).reviews.find(r=>r.id===batch.id)?.status).toBe('applied');
    await review.undoNoteReview(owner,batch.id); await review.undoNoteReview(owner,batch.id);
    expect((await graph.getPersonOverlay(owner,person)).links).toHaveLength(1);
    expect((await review.listNoteReviews(owner,{kind:'user',id:person})).asks).toHaveLength(0);
    expect((await graph.getPersonOverlay(owner,person)).notes.some(n=>n.id===batch.note.id)).toBe(true);
  });
  it('source deletion redacts ready and applied review proposal copies from history and export', async () => {
    const readyText='Secret manual ready ask '+suffix;
    const ready=await review.captureNoteReview(owner,{kind:'user',id:person},{text:readyText,requestId:'delete-ready',asStandingAsk:true});
    await graph.deleteNote(owner,ready.note.id);
    const readyStored=(await review.listNoteReviews(owner,{kind:'user',id:person})).reviews.find(r=>r.id===ready.id)!;
    expect(readyStored.suggestions).toEqual([]); expect(JSON.stringify(readyStored)).not.toContain(readyText);
    expect(JSON.stringify((await graph.exportPrivateGraph(owner)).noteReviews)).not.toContain(readyText);
    await expect(review.applyNoteReview(owner,ready.id,{suggestionIds:[ready.suggestions[0]!.id]})).rejects.toMatchObject({status:409});
    await expect(review.suggestNoteReview(owner,ready.id)).rejects.toMatchObject({status:409});
    const appliedText='Secret manual applied ask '+suffix;
    const applied=await review.captureNoteReview(owner,{kind:'user',id:person},{text:appliedText,requestId:'delete-applied',asStandingAsk:true});
    const saved=await review.applyNoteReview(owner,applied.id,{suggestionIds:[applied.suggestions[0]!.id]});
    await graph.deleteNote(owner,applied.note.id);
    const appliedStored=(await review.listNoteReviews(owner,{kind:'user',id:person})).reviews.find(r=>r.id===applied.id)!;
    expect(appliedStored.suggestions).toEqual([]); expect(JSON.stringify(appliedStored)).not.toContain(appliedText);
    expect(appliedStored.createdRecords).toEqual(saved.createdRecords);
    expect(JSON.stringify((await graph.exportPrivateGraph(owner)).noteReviews)).not.toContain(appliedText);
    await review.undoNoteReview(owner,applied.id);
  });
  it('protects subsequent ask edits and marks deleted source notes explicitly', async () => {
    const batch=await seedReady('An ongoing private ask','edited-one');
    const applied=await review.applyNoteReview(owner,batch.id,{suggestionIds:['ask-one']});
    const edited=await graph.updateAsk(owner,applied.createdRecords![0]!.id,{status:'paused'});
    expect([edited.status,edited.revision]).toEqual(['stale',1]);
    const card=(await review.listNoteReviews(owner,{kind:'user',id:person})).asks.find(a=>a.id===edited.id)!;
    expect([card.status,card.askStatus,card.sourceNoteId,card.reviewId]).toEqual(['paused','stale',batch.note.id,batch.id]);
    await expect(review.undoNoteReview(owner,batch.id)).rejects.toMatchObject({status:409});
    await graph.deleteNote(owner,batch.note.id);
    const stored=(await review.listNoteReviews(owner,{kind:'user',id:person})).reviews.find(r=>r.id===batch.id)!;
    expect(stored.sourceNoteAvailable).toBe(false); expect(stored.note.text).toBe('');
  });
  it.each(['source', 'other-ref', 'account-ref', 'erased'].flatMap(mode => ['saved', 'ready', 'applied'].map(stage => ({ mode, stage }))))('coordinates $stage reviews and $mode card adjuncts with actual canonical account purge', async ({ mode, stage }) => {
    const departing = `departing-${mode}-${stage}-${suffix}`;
    ids.push(departing);
    const marker = `Synthetic erasure ${mode} ${stage} ${suffix}`;
    const db = driver.session();
    try {
      await db.run('CREATE (:User {id:$id,name:$name})', { id:departing, name:marker });
      let batch = await review.captureNoteReview(owner, {kind:'user',id:departing}, {text:marker,requestId:`purge-${mode}-${stage}`,asStandingAsk:stage !== 'saved'});
      expect(batch.status).toBe(stage === 'saved' ? 'saved' : 'ready');
      batch = Object.assign(batch, {extension:{future:[mode,stage,{retained:true}]}});
      const principalBefore = await graph.privateReviewPrincipal(owner);
      await db.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload',
        {id:batch.id,ownerKey:principalBefore.ownerKey,payload:JSON.stringify(batch)});
      const captured = batch;
      if (stage === 'applied') batch = await review.applyNoteReview(owner,batch.id,{suggestionIds:[batch.suggestions[0]!.id]});
      const {principal,entityId} = await graph.privateReviewSubject(owner,{kind:'user',id:departing},false);
      const remaining = `remaining-${departing}`;
      if (mode === 'account-ref') {
        ids.push(remaining);
        await db.run('CREATE (:User {id:$id,name:$id})',{id:remaining});
        const canonical = new OverlayStore(driver,process.env.NEO4J_DATABASE || 'neo4j');
        await canonical.initialize();
        expect((await canonical.ensureRefs(principal,{kind:'person',name:marker,refs:[`openchat:user:${departing}`,`openchat:user:${remaining}`]})).entity.id).toBe(entityId);
      }
      const by = {author:'owner',source:'app',assertion:'stated'} as const;
      await graph.savePeopleState(owner,entityId,{operationId:`old-${mode}`,expectedRevision:0,payload:{schemaVersion:1,historical:marker}},by);
      await graph.savePeopleState(owner,entityId,{operationId:`new-${mode}`,expectedRevision:1,payload:{schemaVersion:1,native:{unknown:marker}}},by);
      if (mode === 'source') await graph.importContactSource(owner,{entityId,source:'synthetic:erasure',sourceId:departing,name:'Independent source name',data:{schemaVersion:1,unknown:marker}},by);
      if (mode === 'other-ref') await db.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$entityId})
        CREATE (:OverlayRef {ownerKey:$ownerKey,entityId:$entityId,ref:$ref})-[:REF_OF]->(e)`, {ownerKey:principal.ownerKey,entityId,ref:`other:person:${departing}`});
      await db.run(`CREATE (:OpenChatPrivateAsk {id:$id,ownerKey:$ownerKey,entityId:$entityId,reviewId:$reviewId,text:$text,revision:0})`,
        {id:`legacy-${departing}`,ownerKey:principal.ownerKey,entityId,reviewId:batch.id,text:marker});
      const before = await graph.readContactState(owner,entityId);
      await db.executeWrite(tx => graph.deletePrivateGraphForUser(tx,departing));
      await db.run('MATCH (u:User {id:$id}) DETACH DELETE u',{id:departing});
      await expect(review.suggestNoteReview(other,batch.id)).rejects.toMatchObject({status:404});
      await expect(review.applyNoteReview(other,batch.id,{suggestionIds:['foreign']})).rejects.toMatchObject({status:404});
      if (mode !== 'erased') {
        expect(await graph.readContactState(owner,entityId)).toEqual(before);
        const exported = await graph.exportPrivateGraph(owner);
        const subject = mode === 'account-ref' ? {kind:'user',id:remaining} as const : {kind:'thing',id:entityId} as const;
        expect(exported.noteReviews).toContainEqual({...batch,subject});
        expect(exported.privateAsks).toContainEqual(expect.objectContaining({id:`legacy-${departing}`,text:marker}));
        const history = await review.listNoteReviews(owner,subject);
        expect(history.reviews).toContainEqual({...batch,subject,sourceNoteAvailable:true});
        expect(await review.captureNoteReview(owner,subject,{text:marker,requestId:`purge-${mode}-${stage}`,asStandingAsk:stage !== 'saved'})).toEqual({...batch,subject});
        vi.stubEnv('ANTHROPIC_API_KEY','synthetic-test-only');
        extraction.mockResolvedValue({content:[{type:'tool_use',name:'propose',input:{suggestions:[{kind:'ask',text:marker,evidenceIndex:0}]}}]});
        if (mode === 'account-ref') {
          await expect(review.listNoteReviews(owner,{kind:'thing',id:entityId})).rejects.toMatchObject({status:404});
          for (const direction of ['out','in']) {
            await db.run(direction === 'out' ? 'MATCH (a:User {id:$owner}),(b:User {id:$remaining}) CREATE (a)-[:BLOCKED]->(b)' : 'MATCH (a:User {id:$owner}),(b:User {id:$remaining}) CREATE (b)-[:BLOCKED]->(a)',{owner,remaining});
            await expect(review.suggestNoteReview(owner,batch.id)).rejects.toMatchObject({status:404});
            await expect(review.applyNoteReview(owner,batch.id,{suggestionIds:[batch.suggestions[0]?.id ?? 'saved']})).rejects.toMatchObject({status:404});
            await db.run('MATCH (:User {id:$owner})-[b:BLOCKED]-(:User {id:$remaining}) DELETE b',{owner,remaining});
          }
          await db.run('MATCH (u:User {id:$remaining}) SET u.isBot=true',{remaining});
          await expect(review.suggestNoteReview(owner,batch.id)).rejects.toMatchObject({status:404});
          await db.run('MATCH (u:User {id:$remaining}) REMOVE u.isBot',{remaining});
        }
        const suggested = await review.suggestNoteReview(owner,batch.id);
        expect(suggested).toMatchObject({subject,status:stage === 'applied' ? 'applied' : 'ready',note:captured.note});
        batch = await review.applyNoteReview(owner,batch.id,{suggestionIds:[suggested.suggestions[0]!.id]});
        expect(batch).toMatchObject({subject,status:'applied'});
        expect((await review.listNoteReviews(owner,subject)).asks).toContainEqual(expect.objectContaining({id:batch.createdRecords![0]!.id,text:marker}));
        expect((await review.undoNoteReview(owner,batch.id)).status).toBe('undone');
        if (mode === 'account-ref') await db.executeWrite(async tx => {
          await graph.deletePrivateGraphForUser(tx,remaining);
          await tx.run('MATCH (u:User {id:$remaining}) DETACH DELETE u',{remaining});
        });
        else await graph.deletePrivateThing(owner,entityId);
      } else {
        await expect(review.suggestNoteReview(owner,batch.id)).rejects.toMatchObject({status:404});
        await expect(review.applyNoteReview(owner,batch.id,{suggestionIds:['erased']})).rejects.toMatchObject({status:404});
        await expect(review.undoNoteReview(owner,batch.id)).rejects.toMatchObject({status:404});
      }
      await expect(graph.readContactState(owner,entityId)).rejects.toMatchObject({status:404});
      expect(JSON.stringify(await graph.exportPrivateGraph(owner))).not.toContain(marker);
      const remnants = await db.run(`MATCH (n {ownerKey:$ownerKey}) WHERE n.entityId=$entityId OR n.id=$entityId
        OR n.id IN $askIds RETURN count(n) AS total`, {ownerKey:principal.ownerKey,entityId,askIds:(batch.createdRecords ?? []).map(r=>r.id)});
      expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
    } finally { await db.close(); }
  });

  it.each(['source', 'other-ref', 'erased'])('coordinates an owner captured before the lifecycle fence with the actual %s purge outcome', async mode => {
    const departing = `late-departing-${mode}-${suffix}`, lateOwner = `late-owner-${mode}-${suffix}`;
    ids.push(departing, lateOwner);
    const marker = `Synthetic late owner ${mode} ${suffix}`;
    const db = driver.session();
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const inventory = new Promise<void>(resolve => { reached = resolve; });
    let pending: Promise<void> | undefined;
    try {
      await db.run('UNWIND $ids AS id CREATE (:User {id:id,name:id})',{ids:[departing,lateOwner]});
      const unrelated = await review.captureNoteReview(other,{kind:'user',id:person},{text:`Unrelated ${marker}`,requestId:`unrelated-${mode}`});
      const unrelatedBefore = await graph.exportPrivateGraph(other);
      pending = db.executeWrite(async tx => {
        let paused = false;
        await graph.deletePrivateGraphForUser({run:async (query, parameters) => {
          if (!paused) {
            paused = true;
            reached();
            await held;
          }
          return tx.run(query,parameters);
        }},departing);
        await tx.run('MATCH (u:User {id:$id}) DETACH DELETE u',{id:departing});
      });
      await Promise.race([inventory,pending.then(() => { throw new Error('Erasure did not reach the barrier'); })]);
      let batch = await review.captureNoteReview(lateOwner,{kind:'user',id:departing},{text:marker,requestId:`late-${mode}`,asStandingAsk:true});
      const {principal,entityId} = await graph.privateReviewSubject(lateOwner,{kind:'user',id:departing},false);
      const by = {author:'owner',source:'app',assertion:'stated'} as const;
      await graph.savePeopleState(lateOwner,entityId,{operationId:'late-old',expectedRevision:0,payload:{schemaVersion:1,historical:marker}},by);
      await graph.savePeopleState(lateOwner,entityId,{operationId:'late-new',expectedRevision:1,payload:{schemaVersion:1,native:{unknown:marker}}},by);
      if (mode === 'source') await graph.importContactSource(lateOwner,{entityId,source:'synthetic:late',sourceId:departing,name:'Independent late name',data:{schemaVersion:1,unknown:marker}},by);
      if (mode === 'other-ref') {
        const seed = driver.session();
        try { await seed.run(`MATCH (e:OverlayEntity {id:$entityId,ownerKey:$ownerKey})
          CREATE (:OverlayRef {ownerKey:$ownerKey,entityId:$entityId,ref:$ref})-[:REF_OF]->(e)`,{entityId,ownerKey:principal.ownerKey,ref:`other:person:${departing}`}); }
        finally { await seed.close(); }
      }
      batch = Object.assign(batch,{extension:{future:[mode,{retained:true}]}});
      const seed = driver.session();
      try {
        await seed.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload',{id:batch.id,ownerKey:principal.ownerKey,payload:JSON.stringify(batch)});
        await seed.run('CREATE (:OpenChatPrivateAsk {id:$id,ownerKey:$ownerKey,entityId:$entityId,text:$text})',{id:`legacy-${departing}`,ownerKey:principal.ownerKey,entityId,text:marker});
      } finally { await seed.close(); }
      const before = await graph.readContactState(lateOwner,entityId);
      release();
      await pending;
      expect(await graph.exportPrivateGraph(other)).toEqual(unrelatedBefore);
      expect(unrelatedBefore.noteReviews).toContainEqual(unrelated);
      await expect(review.undoNoteReview(other,batch.id)).rejects.toMatchObject({status:404});
      if (mode === 'erased') {
        expect(JSON.stringify(await graph.exportPrivateGraph(lateOwner))).not.toContain(marker);
        await expect(review.suggestNoteReview(lateOwner,batch.id)).rejects.toMatchObject({status:404});
        await expect(review.undoNoteReview(lateOwner,batch.id)).rejects.toMatchObject({status:404});
      } else {
        const subject = {kind:'thing',id:entityId} as const;
        expect(await graph.readContactState(lateOwner,entityId)).toEqual(before);
        const exported = await graph.exportPrivateGraph(lateOwner);
        expect(exported.noteReviews).toContainEqual({...batch,subject});
        expect(exported.privateAsks).toContainEqual(expect.objectContaining({id:`legacy-${departing}`,text:marker}));
        expect(await review.suggestNoteReview(lateOwner,batch.id)).toEqual({...batch,subject});
        expect(await review.applyNoteReview(lateOwner,batch.id,{suggestionIds:[batch.suggestions[0]!.id]})).toMatchObject({subject,status:'applied',extension:{future:[mode,{retained:true}]}});
        expect((await review.undoNoteReview(lateOwner,batch.id)).status).toBe('undone');
        await graph.deletePrivateThing(lateOwner,entityId);
      }
      const remnants = await db.run('MATCH (n {ownerKey:$ownerKey}) WHERE n.entityId=$entityId OR n.id=$entityId RETURN count(n) AS total',{ownerKey:principal.ownerKey,entityId});
      expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
      expect(JSON.stringify(await graph.exportPrivateGraph(lateOwner))).not.toContain(marker);
    } finally {
      release();
      await pending?.catch(() => {});
      await db.close();
    }
  });

  it.each([false,true])('fences new owners capturing after canonical candidate discovery with standing ask %s', async asStandingAsk => {
    const departing = `inventory-departing-${asStandingAsk}-${suffix}`;
    const lateOwners = [0,1].map(index => `inventory-owner-${asStandingAsk}-${index}-${suffix}`);
    ids.push(departing,...lateOwners);
    const marker = `Synthetic after canonical discovery ${asStandingAsk} ${suffix}`;
    const db = driver.session();
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const inventory = new Promise<void>(resolve => { reached = resolve; });
    let deletion: Promise<void> | undefined;
    const captures: Array<Promise<{error:unknown} | {batch:import('../src/services/privateNoteReview.js').NoteReview}>> = [];
    try {
      await db.run('UNWIND $ids AS id CREATE (:User {id:id,name:id})',{ids:[departing,...lateOwners]});
      const before = await Promise.all(lateOwners.map(id => graph.exportPrivateGraph(id)));
      const principals = await Promise.all(lateOwners.map(id => graph.privateReviewPrincipal(id)));
      deletion = db.executeWrite(async tx => {
        let paused = false;
        await graph.deletePrivateGraphForUser({run:async (query,parameters) => {
          const result = await tx.run(query,parameters);
          if (!paused && parameters?.ref === `openchat:user:${departing}` && query.includes('RETURN DISTINCT e.ownerKey')) {
            paused = true;
            expect(result.records).toHaveLength(0);
            reached();
            await held;
          }
          return result;
        }},departing);
        await tx.run('MATCH (u:User {id:$id}) DETACH DELETE u',{id:departing});
      });
      await Promise.race([inventory,deletion.then(() => { throw new Error('Purge did not reach candidate discovery'); })]);
      for (const lateOwner of lateOwners) captures.push(review.captureNoteReview(lateOwner,{kind:'user',id:departing},
        {text:marker,requestId:`after-inventory-${asStandingAsk}`,asStandingAsk}).then(batch => ({batch}),error => ({error})));
      const inspector = driver.session();
      try {
        await Promise.race([
          vi.waitFor(async () => {
            const transactions = await inspector.run('SHOW TRANSACTIONS YIELD status, parameters RETURN status, parameters');
            const blocked = transactions.records.filter(row => String(row.get('status')).startsWith('Blocked') && row.get('parameters')?.userId === departing);
            expect(blocked).toHaveLength(lateOwners.length);
          },{timeout:10000,interval:20}),
          ...captures.map(pending => pending.then(() => { throw new Error('Capture escaped the account lifecycle fence'); })),
        ]);
      } finally { await inspector.close(); }
      release();
      await deletion;
      expect(await Promise.all(captures)).toEqual(lateOwners.map(() => ({error:expect.objectContaining({status:404})})));
      for (const [index,lateOwner] of lateOwners.entries()) {
        expect(await graph.exportPrivateGraph(lateOwner)).toEqual(before[index]);
        const remnants = await db.run('MATCH (n {ownerKey:$ownerKey}) RETURN count(n) AS total',{ownerKey:principals[index]!.ownerKey});
        expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
        await expect(review.captureNoteReview(lateOwner,{kind:'user',id:departing},{text:marker,requestId:'retry-after-inventory',asStandingAsk})).rejects.toMatchObject({status:404});
      }
      const refs = await db.run('MATCH (r:OverlayRef {ref:$ref}) RETURN count(r) AS total',{ref:`openchat:user:${departing}`});
      expect(refs.records[0]!.get('total').toNumber()).toBe(0);
    } finally {
      release();
      await deletion?.catch(() => {});
      await Promise.all(captures);
      await db.close();
    }
  },20000);

  it.each(['source', 'other-ref', 'account-ref', 'erased'].flatMap(mode => [false,true].map(asStandingAsk => ({mode,asStandingAsk}))))('revalidates delayed capture after $mode erasure with standing ask $asStandingAsk', async ({mode,asStandingAsk}) => {
    const departing = `delayed-${mode}-${asStandingAsk}-${suffix}`;
    ids.push(departing);
    const marker = `Synthetic delayed capture ${mode} ${asStandingAsk} ${suffix}`;
    const db = driver.session();
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const resolved = new Promise<void>(resolve => { reached = resolve; });
    let pending: Promise<{batch:import('../src/services/privateNoteReview.js').NoteReview} | {error:unknown}> | undefined;
    try {
      await db.run('CREATE (:User {id:$id,name:$id})',{id:departing});
      const {principal,entityId} = await graph.privateReviewSubject(owner,{kind:'user',id:departing});
      const remaining = `remaining-${departing}`;
      if (mode === 'account-ref') {
        ids.push(remaining);
        await db.run('CREATE (:User {id:$id,name:$id})',{id:remaining});
        const canonical = new OverlayStore(driver,process.env.NEO4J_DATABASE || 'neo4j');
        await canonical.initialize();
        expect((await canonical.ensureRefs(principal,{kind:'person',name:marker,refs:[`openchat:user:${departing}`,`openchat:user:${remaining}`]})).entity.id).toBe(entityId);
      }
      if (mode === 'source') await graph.importContactSource(owner,{entityId,source:'synthetic:delayed',sourceId:departing,name:'Independent delayed name',data:{schemaVersion:1}},
        {author:'owner',source:'app',assertion:'stated'});
      if (mode === 'other-ref') await db.run(`MATCH (e:OverlayEntity {id:$entityId,ownerKey:$ownerKey})
        CREATE (:OverlayRef {ownerKey:$ownerKey,entityId:$entityId,ref:$ref})-[:REF_OF]->(e)`,{entityId,ownerKey:principal.ownerKey,ref:`other:person:${departing}`});
      interleaving.afterSubject = async () => { reached(); await held; };
      pending = review.captureNoteReview(owner,{kind:'user',id:departing},{text:marker,requestId:`delayed-${mode}-${asStandingAsk}`,asStandingAsk})
        .then(batch => ({batch}),error => ({error}));
      await Promise.race([resolved,pending.then(() => { throw new Error('Capture did not resolve its subject'); })]);
      await db.executeWrite(async tx => {
        await graph.deletePrivateGraphForUser(tx,departing);
        await tx.run('MATCH (u:User {id:$id}) DETACH DELETE u',{id:departing});
      });
      release();
      const outcome = await pending;
      if (mode === 'erased') {
        expect(outcome).toMatchObject({error:{status:404}});
      } else {
        expect(outcome).toHaveProperty('batch');
        if (!('batch' in outcome)) throw outcome.error;
        const batch = outcome.batch, subject = mode === 'account-ref' ? {kind:'user',id:remaining} as const : {kind:'thing',id:entityId} as const;
        expect(batch).toMatchObject({subject,status:asStandingAsk ? 'ready' : 'saved'});
        expect((await graph.exportPrivateGraph(owner)).noteReviews).toContainEqual(batch);
        expect(await review.captureNoteReview(owner,subject,{text:marker,requestId:`delayed-${mode}-${asStandingAsk}`,asStandingAsk})).toEqual(batch);
        vi.stubEnv('ANTHROPIC_API_KEY','synthetic-test-only');
        extraction.mockResolvedValue({content:[{type:'tool_use',name:'propose',input:{suggestions:[{kind:'ask',text:marker,evidenceIndex:0}]}}]});
        const suggested = await review.suggestNoteReview(owner,batch.id);
        expect(suggested).toMatchObject({subject,status:'ready'});
        const applied = await review.applyNoteReview(owner,batch.id,{suggestionIds:[suggested.suggestions[0]!.id]});
        expect(applied).toMatchObject({subject,status:'applied'});
        expect((await review.listNoteReviews(owner,subject)).asks).toContainEqual(expect.objectContaining({id:applied.createdRecords![0]!.id,text:marker}));
        await review.undoNoteReview(owner,batch.id);
        if (mode === 'account-ref') await db.executeWrite(async tx => {
          await graph.deletePrivateGraphForUser(tx,remaining);
          await tx.run('MATCH (u:User {id:$remaining}) DETACH DELETE u',{remaining});
        });
        else await graph.deletePrivateThing(owner,entityId);
      }
      expect(JSON.stringify(await graph.exportPrivateGraph(owner))).not.toContain(marker);
      const remnants = await db.run('MATCH (n {ownerKey:$ownerKey}) WHERE n.entityId=$entityId OR n.id=$entityId RETURN count(n) AS total',{ownerKey:principal.ownerKey,entityId});
      expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
    } finally {
      release();
      await pending;
      await db.close();
    }
  });

  it('keeps the rebound subject when extraction started before account deletion finishes later', async () => {
    const departing = `departing-extracting-${suffix}`;
    ids.push(departing);
    const marker = `Synthetic in-flight extraction ${suffix}`;
    const db = driver.session();
    let finish!: () => void;
    let pending: Promise<import('../src/services/privateNoteReview.js').NoteReview> | undefined;
    try {
      await db.run('CREATE (:User {id:$id,name:$id})',{id:departing});
      const batch = await review.captureNoteReview(owner,{kind:'user',id:departing},{text:marker,requestId:'purge-extracting'});
      const {entityId} = await graph.privateReviewSubject(owner,{kind:'user',id:departing},false);
      await graph.importContactSource(owner,{entityId,source:'synthetic:erasure',sourceId:departing,name:'Independent source name',data:{schemaVersion:1}},
        {author:'owner',source:'app',assertion:'stated'});
      vi.stubEnv('ANTHROPIC_API_KEY','synthetic-test-only');
      let started!: () => void;
      const extracting = new Promise<void>(resolve => { started = resolve; });
      extraction.mockImplementationOnce(() => {
        started();
        return new Promise(resolve => { finish = () => resolve({content:[{type:'tool_use',name:'propose',input:{suggestions:[{kind:'ask',text:marker,evidenceIndex:0}]}}]}); });
      });
      pending = review.suggestNoteReview(owner,batch.id);
      await Promise.race([extracting,pending.then(() => { throw new Error('Extraction did not start'); })]);
      await db.executeWrite(tx => graph.deletePrivateGraphForUser(tx,departing));
      await db.run('MATCH (u:User {id:$id}) DETACH DELETE u',{id:departing});
      finish();
      const suggested = await pending;
      expect(suggested).toMatchObject({subject:{kind:'thing',id:entityId},status:'ready',note:batch.note});
      expect((await graph.exportPrivateGraph(owner)).noteReviews).toContainEqual(suggested);
      const applied = await review.applyNoteReview(owner,batch.id,{suggestionIds:[suggested.suggestions[0]!.id]});
      expect(applied).toMatchObject({subject:{kind:'thing',id:entityId},status:'applied'});
      await review.undoNoteReview(owner,batch.id);
      await graph.deletePrivateThing(owner,entityId);
    } finally {
      finish?.();
      await pending?.catch(() => {});
      await db.close();
    }
  });

  it('erases source-backed owner data, adjuncts and historical People operation payloads together', async () => {
    const sourceOwner = `source-owner-${suffix}`;
    ids.push(sourceOwner);
    const marker = `Synthetic owner erasure ${suffix}`;
    const db = driver.session();
    try {
      await db.run('CREATE (:User {id:$id,name:$id})',{id:sourceOwner});
      const by = {author:'owner',source:'app',assertion:'stated'} as const;
      const imported = await graph.importContactSource(sourceOwner,{source:'synthetic:owner-erasure',sourceId:sourceOwner,name:'Saved source',data:{schemaVersion:1,unknown:marker}},by);
      const entityId = imported.entity.id;
      const batch = await review.captureNoteReview(sourceOwner,{kind:'thing',id:entityId},{text:marker,requestId:'owner-erasure',asStandingAsk:true});
      await review.applyNoteReview(sourceOwner,batch.id,{suggestionIds:[batch.suggestions[0]!.id]});
      await graph.savePeopleState(sourceOwner,entityId,{operationId:'owner-old',expectedRevision:0,payload:{schemaVersion:1,historical:marker}},by);
      await graph.savePeopleState(sourceOwner,entityId,{operationId:'owner-new',expectedRevision:1,payload:{schemaVersion:1,native:{unknown:marker}}},by);
      const principal = await graph.privateReviewPrincipal(sourceOwner);
      await db.run(`CREATE (:OpenChatPrivateAsk {id:$id,ownerKey:$ownerKey,entityId:$entityId,text:$text})`,
        {id:`legacy-${sourceOwner}`,ownerKey:principal.ownerKey,entityId,text:marker});
      await db.executeWrite(tx => graph.deletePrivateGraphForUser(tx,sourceOwner));
      expect(await graph.exportPrivateGraph(sourceOwner)).toEqual({entities:[],notes:[],links:[],noteReviews:[],privateAsks:[]});
      const remnants = await db.run('MATCH (n {ownerKey:$ownerKey}) RETURN count(n) AS total',{ownerKey:principal.ownerKey});
      expect(remnants.records[0]!.get('total').toNumber()).toBe(0);
      await expect(review.undoNoteReview(sourceOwner,batch.id)).rejects.toMatchObject({status:404});
    } finally { await db.close(); }
  });

});
