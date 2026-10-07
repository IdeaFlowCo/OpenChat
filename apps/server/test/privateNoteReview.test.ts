import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), subject: vi.fn(), principal: vi.fn(), addNote: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close, executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: mocks.run }) }) }) }));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, privateReviewSubject: mocks.subject, privateReviewPrincipal: mocks.principal, addNote: mocks.addNote };
});
import { captureNoteReview, parseSuggestions, similarAsk, undoNoteReview, applyNoteReview } from '../src/services/privateNoteReview.js';

const review = { id: 'review-id', subject: {kind:'user',id:'bob'}, note:{id:'raw-note',text:'Chet works at Acme',createdAt:'now',updatedAt:'now'},status:'applied',suggestions:[],appliedIds:['s1'],createdAt:'now',createdRecords:[{id:'new-link',kind:'connection',suggestionId:'s1'},{id:'new-ask',kind:'ask',suggestionId:'s2'}] };
const rows = (data: Record<string, unknown>) => ({ records: [{get: (key: string) => data[key]}] });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue({app:'openchat',ownerKey:'owner-key'});
  mocks.subject.mockResolvedValue({principal:{app:'openchat',ownerKey:'owner-key'},entityId:'entity-id',name:'Chet'});
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
describe('durable batch operations', () => {
  it('returns prior capture on retry without writing a second raw note', async () => {
    const saved = {...review,status:'saved',createdRecords:[]};
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}) RETURN') ? rows({payload:JSON.stringify(saved)}) : {records:[]});
    expect(await captureNoteReview('alice',{kind:'user',id:'bob'},{text:saved.note.text,requestId:'retry-key'})).toEqual(saved);
    expect(mocks.addNote).not.toHaveBeenCalled();
  });
  it('rejects reuse of a capture request ID for a different note', async () => {
    mocks.run.mockImplementation(async (query: string) => query.includes('requestId:$requestId}) RETURN') ? rows({payload:JSON.stringify(review)}) : {records:[]});
    await expect(captureNoteReview('alice',{kind:'user',id:'bob'},{text:'Different note',requestId:'retry-key'})).rejects.toMatchObject({status:409});
    expect(mocks.addNote).not.toHaveBeenCalled();
  });
  it('undo after reload deletes only ledger-created records and preserves the raw note', async () => {
    mocks.run.mockImplementation(async (query: string) => query.includes('RETURN r.payload') ? rows({payload:JSON.stringify(review)}) : {records:[]});
    const undone = await undoNoteReview('alice','review-id');
    expect(undone.status).toBe('undone');
    const deletes = mocks.run.mock.calls.filter(([query]) => query.includes('DELETE'));
    expect(deletes).toHaveLength(2);
    expect(deletes.map(([,params]) => params.id)).toEqual(['new-link','new-ask']);
    expect(deletes.every(([query,params]) => query.includes('ownerKey') && params.ownerKey === 'owner-key')).toBe(true);
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
    expect(mocks.run.mock.calls.every(([,params]) => params.ownerKey === 'owner-key')).toBe(true);
    expect(mocks.run.mock.calls.some(([query]) => query.includes('DELETE'))).toBe(false);
  });
});
