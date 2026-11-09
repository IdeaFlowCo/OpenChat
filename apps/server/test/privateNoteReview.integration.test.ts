import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
const extraction = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: extraction }; } }));
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
  afterEach(() => { vi.unstubAllEnvs(); extraction.mockReset(); });
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
  it.each(['source', 'other-ref', 'erased'].flatMap(mode => ['saved', 'ready', 'applied'].map(stage => ({ mode, stage }))))('coordinates $stage reviews and $mode card adjuncts with actual canonical account purge', async ({ mode, stage }) => {
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
        const subject = {kind:'thing',id:entityId} as const;
        expect(exported.noteReviews).toContainEqual({...batch,subject});
        expect(exported.privateAsks).toContainEqual(expect.objectContaining({id:`legacy-${departing}`,text:marker}));
        const history = await review.listNoteReviews(owner,{kind:'thing',id:entityId});
        expect(history.reviews).toContainEqual({...batch,subject,sourceNoteAvailable:true});
        expect(await review.captureNoteReview(owner,subject,{text:marker,requestId:`purge-${mode}-${stage}`,asStandingAsk:stage !== 'saved'})).toEqual({...batch,subject});
        vi.stubEnv('ANTHROPIC_API_KEY','synthetic-test-only');
        extraction.mockResolvedValue({content:[{type:'tool_use',name:'propose',input:{suggestions:[{kind:'ask',text:marker,evidenceIndex:0}]}}]});
        const suggested = await review.suggestNoteReview(owner,batch.id);
        expect(suggested).toMatchObject({subject,status:stage === 'applied' ? 'applied' : 'ready',note:captured.note});
        batch = await review.applyNoteReview(owner,batch.id,{suggestionIds:[suggested.suggestions[0]!.id]});
        expect(batch).toMatchObject({subject,status:'applied'});
        expect((await review.listNoteReviews(owner,subject)).asks).toContainEqual(expect.objectContaining({id:batch.createdRecords![0]!.id,text:marker}));
        expect((await review.undoNoteReview(owner,batch.id)).status).toBe('undone');
        await graph.deletePrivateThing(owner,entityId);
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
