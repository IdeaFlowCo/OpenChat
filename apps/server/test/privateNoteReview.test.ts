import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), subject: vi.fn(), principal: vi.fn(), addNote: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close, executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: mocks.run }), executeRead: (fn: (tx: unknown) => unknown) => fn({ run: mocks.run }) }) }) }));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, privateReviewSubject: mocks.subject, privateReviewPrincipal: mocks.principal, addNote: mocks.addNote };
});
vi.mock('../src/services/overlay/store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/overlay/store.js')>('../src/services/overlay/store.js');
  return { ...actual, addNoteIn: mocks.addNote };
});
import { captureNoteReview, listNoteReviews, parseSuggestions, similarAsk, undoNoteReview, applyNoteReview } from '../src/services/privateNoteReview.js';
import { lockPrivateReviewSubjectIn } from '../src/services/privateGraph.js';
import { ownerKeyFor } from '../src/services/overlay/contract.js';

const OWNER_KEY = ownerKeyFor('https://chat.ideaflow.app/openchat-user','alice');
const review = { id: 'review-id', subject: {kind:'user',id:'bob'}, note:{id:'raw-note',text:'Chet works at Acme',createdAt:'now',updatedAt:'now'},status:'applied',suggestions:[],appliedIds:['s1'],createdAt:'now',createdRecords:[{id:'new-link',kind:'connection',suggestionId:'s1'},{id:'new-ask',kind:'ask',suggestionId:'s2'}] };
const rows = (data: Record<string, unknown>) => ({ records: [{get: (key: string) => data[key]}] });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue({app:'openchat',ownerKey:OWNER_KEY});
  mocks.subject.mockResolvedValue({principal:{app:'openchat',ownerKey:OWNER_KEY},entityId:'entity-id',name:'Chet'});
  mocks.run.mockResolvedValue({records:[]});
});
describe('private note review source validation', () => {
  it('accepts literal evidence and typed targets but refuses invented provenance', () => {
    const proposal = {kind:'connection',text:'Works at Acme',relation:'Works AT',target:{kind:'company',name:'Acme'},evidence:'works at Acme'};
    expect(parseSuggestions([proposal],'Chet works at Acme')[0]).toMatchObject({relation:'works at',target:{kind:'company',name:'Acme'}});
    expect(() => parseSuggestions([{...proposal,evidence:'is the CEO'}],'Chet works at Acme')).toThrow('Source excerpt');
    expect(() => parseSuggestions([{...proposal,target:{kind:'account',name:'Acme'}}],'Chet works at Acme')).toThrow('saved item type');
  });
  it('warns about overlapping asks without changing their text', () => {
    expect(similarAsk('Find cool people in Sacramento','Find cool people Sacramento')).toBe(true);
    expect(similarAsk('Find investors in Paris','Find cool people Sacramento')).toBe(false);
  });
});
describe('review subject validation under the entity lock', () => {
  it('retains the exact attached account subject', async () => {
    const run = vi.fn().mockResolvedValue(rows({entityId:'entity-id',refs:['openchat:user:bob%3Aexternal']}));
    const subject = {kind:'user',id:'bob:external'} as const;
    expect(await lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',subject,'alice')).toEqual({entityId:'entity-id',subject});
  });
  it.each([{refs:[]},{refs:['other:person:bob']}])('normalizes a surviving card with refs $refs to its canonical identity', async ({refs}) => {
    const run = vi.fn().mockResolvedValue(rows({entityId:'entity-id',refs}));
    expect(await lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'user',id:'bob'},'alice')).toEqual({entityId:'entity-id',subject:{kind:'thing',id:'entity-id'}});
  });
  it('refuses erased or foreign entities instead of saving an orphan', async () => {
    const run = vi.fn(async (_query: string, parameters?: Record<string, unknown>) =>
      parameters?.entityId ? {records:[]} : rows({id:parameters?.userId}));
    await expect(lockPrivateReviewSubjectIn({run},OWNER_KEY,'missing',{kind:'user',id:'bob'},'alice')).rejects.toMatchObject({status:404});
  });
  it('uses a surviving card after the original account disappears', async () => {
    const run = vi.fn(async (_query: string, parameters?: Record<string, unknown>) =>
      parameters?.userId === 'bob' ? {records:[]} : rows({entityId:'entity-id',refs:['other:person:bob']}));
    expect(await lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'user',id:'bob'},'alice')).toEqual({entityId:'entity-id',subject:{kind:'thing',id:'entity-id'}});
  });
  it('refuses a stale attached account that no longer exists', async () => {
    const run = vi.fn(async (_query: string, parameters?: Record<string, unknown>) =>
      parameters?.userId === 'bob' ? {records:[]} : rows({entityId:'entity-id',refs:['openchat:user:bob']}));
    await expect(lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'user',id:'bob'},'alice')).rejects.toMatchObject({status:404});
  });
  it('refuses capture after the owning account disappears', async () => {
    const run = vi.fn(async (_query: string, parameters?: Record<string, unknown>) =>
      parameters?.userId === 'alice' ? {records:[]} : rows({entityId:'entity-id',refs:[]}));
    await expect(lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'thing',id:'entity-id'},'alice')).rejects.toMatchObject({status:404});
  });
  it('uses the surviving associated account after its original ref is purged', async () => {
    const run = vi.fn().mockResolvedValue(rows({entityId:'entity-id',refs:['openchat:user:carol']}));
    expect(await lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'user',id:'bob'},'alice')).toEqual({entityId:'entity-id',subject:{kind:'user',id:'carol'}});
  });
  it.each([{blocked:true},{isBot:true}])('refuses an inaccessible surviving account: %j', async access => {
    const run = vi.fn().mockResolvedValue(rows({entityId:'entity-id',refs:['openchat:user:carol'],...access}));
    await expect(lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'user',id:'bob'},'alice')).rejects.toMatchObject({status:404});
  });
  it('refuses a changed owner binding before saving a review', async () => {
    const run = vi.fn().mockResolvedValue(rows({entityId:'entity-id',refs:[],issuer:'https://different-owner.test',subject:'new-owner'}));
    await expect(lockPrivateReviewSubjectIn({run},OWNER_KEY,'entity-id',{kind:'user',id:'bob'},'alice')).rejects.toMatchObject({status:409,details:{code:'contact_owner_changed'}});
  });
});
describe('durable batch operations', () => {
  it('returns prior capture on retry without writing a second raw note', async () => {
    const saved = {...review,status:'saved',createdRecords:[]};
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}') ? rows({payload:JSON.stringify(saved)}) : rows({entityId:'entity-id',refs:['openchat:user:bob']}));
    expect(await captureNoteReview('alice',{kind:'user',id:'bob'},{text:saved.note.text,requestId:'retry-key'})).toEqual(saved);
    expect(mocks.addNote).not.toHaveBeenCalled();
  });
  it('rejects reuse of a capture request ID for a different note', async () => {
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}') ? rows({payload:JSON.stringify(review)}) : rows({entityId:'entity-id',refs:['openchat:user:bob']}));
    await expect(captureNoteReview('alice',{kind:'user',id:'bob'},{text:'Different note',requestId:'retry-key'})).rejects.toMatchObject({status:409});
    expect(mocks.addNote).not.toHaveBeenCalled();
  });
  it('prefers an exact record receipt when merged members reused a request ID', async () => {
    const saved = {...review,status:'saved',createdRecords:[]};
    const other = {...saved,id:'other-review',note:{...saved.note,text:'Another note'}};
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}')
      ? {records:[rows({entityId:'other-id',payload:JSON.stringify(other)}).records[0],rows({entityId:'entity-id',payload:JSON.stringify(saved)}).records[0]]}
      : rows({entityId:'entity-id',refs:['openchat:user:bob']}));
    expect(await captureNoteReview('alice',{kind:'user',id:'bob'},{text:saved.note.text,requestId:'shared-key'})).toEqual(saved);
    expect(mocks.addNote).not.toHaveBeenCalled();
  });
  it.each(['entity-id','member-id'])('replays the exact %s receipt for identical merged captures', async requestedId => {
    const applied = {...review,createdAt:'2026-01-01T00:00:00.000Z'};
    const saved = {...review,id:'saved-review',status:'saved',appliedIds:[],createdRecords:[],createdAt:'2026-02-01T00:00:00.000Z'};
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}')
      ? {records:[rows({entityId:'entity-id',payload:JSON.stringify(applied)}).records[0],rows({entityId:'member-id',payload:JSON.stringify(saved)}).records[0]]}
      : rows({entityId:'entity-id',refs:[]}));
    expect(await captureNoteReview('alice',{kind:'thing',id:requestedId},{text:review.note.text,requestId:'same-key'})).toEqual(requestedId === 'entity-id' ? applied : saved);
  });
  it('refuses a conflicting exact receipt even when another member matches', async () => {
    const other = {...review,id:'other-review',note:{...review.note,text:'Another note'}};
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}')
      ? {records:[rows({entityId:'other-id',payload:JSON.stringify(other)}).records[0],rows({entityId:'entity-id',payload:JSON.stringify(review)}).records[0]]}
      : rows({entityId:'entity-id',refs:[]}));
    await expect(captureNoteReview('alice',{kind:'thing',id:'entity-id'},{text:other.note.text,requestId:'same-key'})).rejects.toMatchObject({status:409});
  });
  it('falls back to the oldest receipt and breaks timestamp ties by review id', async () => {
    const newer = {...review,id:'newer',createdAt:'2026-02-01T00:00:00.000Z'};
    const oldest = {...review,id:'a-oldest',createdAt:'2026-01-01T00:00:00.000Z'};
    const tied = {...oldest,id:'z-oldest'};
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}')
      ? {records:[newer,tied,oldest].map((value,index) => rows({entityId:`member-${index}`,payload:JSON.stringify(value)}).records[0])}
      : rows({entityId:'entity-id',refs:[]}));
    expect(await captureNoteReview('alice',{kind:'thing',id:'no-receipt'},{text:review.note.text,requestId:'same-key'})).toEqual(oldest);
  });
  it('saves the note and ledger on the head resolved under the membership lock', async () => {
    mocks.subject.mockResolvedValue({principal:{app:'openchat',ownerKey:OWNER_KEY},entityId:'stale-id',name:'Chet'});
    let stored: Record<string, unknown> | undefined;
    mocks.run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      if (query.includes('CREATE (r:OpenChatNoteReview')) stored = params;
      if (query.includes('requestId:$requestId}')) return {records:[]};
      return rows({entityId:'current-head',refs:[]});
    });
    mocks.addNote.mockResolvedValue({note:review.note});
    const saved = await captureNoteReview('alice',{kind:'thing',id:'stale-id'},{text:review.note.text,requestId:'stale-head'});
    expect(saved.subject).toEqual({kind:'thing',id:'current-head'});
    expect(mocks.addNote).toHaveBeenCalledWith(expect.anything(),OWNER_KEY,'current-head',review.note.text,expect.anything());
    expect(stored).toMatchObject({entityId:'current-head',ownerKey:OWNER_KEY});
    expect(JSON.parse(stored!.payload as string)).toEqual(saved);
  });
  it('includes member reviews and retained member source notes in history', async () => {
    const saved = {...review,status:'saved',createdRecords:[]};
    mocks.run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      if (params.ownerKey !== OWNER_KEY) return {records:[]};
      if (query.includes('RETURN m.mergedInto AS head')) return rows({head:'entity-id',id:'member-id'});
      if (!(params.entityIds as string[] | undefined)?.includes('member-id')) return {records:[]};
      if (query.includes('OpenChatNoteReview')) return rows({payload:JSON.stringify(saved)});
      if (query.includes('OverlayNote')) return rows({id:saved.note.id});
      return {records:[]};
    });
    expect(await listNoteReviews('alice',{kind:'thing',id:'entity-id'})).toEqual({
      reviews:[{...saved,sourceNoteAvailable:true}],asks:[],
    });
  });
  it('undo after reload deletes only ledger-created records and preserves the raw note', async () => {
    // The vendored deleteLinkIn reads the link first (an ask's asker link is refused, Noos 2026-11-03).
    mocks.run.mockImplementation(async (query: string) => query.includes('RETURN r.payload') ? rows({payload:JSON.stringify(review)}) : query.includes('AS askerLink') ? rows({askerLink:false}) : {records:[]});
    const undone = await undoNoteReview('alice','review-id');
    expect(undone.status).toBe('undone');
    const deletes = mocks.run.mock.calls.filter(([query]) => query.includes('DELETE'));
    expect(deletes).toHaveLength(2);
    expect(deletes.map(([,params]) => params.id ?? params.linkId)).toEqual(['new-link','new-ask']);
    expect(deletes.every(([query,params]) => query.includes('ownerKey') && params.ownerKey === OWNER_KEY)).toBe(true);
    expect(mocks.run.mock.calls.some(([query]) => query.includes('OverlayNote') || query.includes('DELETE e'))).toBe(false);
  });
  it('repeated apply and undo are idempotent', async () => {
    mocks.run.mockResolvedValue(rows({payload:JSON.stringify(review)}));
    expect((await applyNoteReview('alice','review-id',{suggestionIds:['s1']})).status).toBe('applied');
    expect(mocks.run.mock.calls.some(([query]) => query.includes('CREATE '))).toBe(false);
    mocks.run.mockResolvedValue(rows({payload:JSON.stringify({...review,status:'undone'})}));
    expect((await undoNoteReview('alice','review-id')).status).toBe('undone');
    expect(mocks.run.mock.calls.some(([query]) => query.includes('DELETE '))).toBe(false);
  });
  it('does not reveal or delete a different owner review', async () => {
    await expect(undoNoteReview('mallory','review-id')).rejects.toMatchObject({status:404});
    expect(mocks.run.mock.calls.every(([,params]) => params.ownerKey === OWNER_KEY)).toBe(true);
    expect(mocks.run.mock.calls.some(([query]) => query.includes('DELETE'))).toBe(false);
  });
});
