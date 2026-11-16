import {beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({bindTripMemoryThing: vi.fn(), tripMemoryThingId: vi.fn(), getImportedChat: vi.fn(), getImportedMessage: vi.fn(), listImportedMessages: vi.fn(), listThings: vi.fn(), getThing: vi.fn(), resolvePrivateThing: vi.fn(), addNote: vi.fn()}));
vi.mock('../src/services/importedChats.js', async importOriginal => ({...await importOriginal<typeof import('../src/services/importedChats.js')>(), bindTripMemoryThing: mocks.bindTripMemoryThing, tripMemoryThingId: mocks.tripMemoryThingId, getImportedChat: mocks.getImportedChat, getImportedMessage: mocks.getImportedMessage, listImportedMessages: mocks.listImportedMessages}));
vi.mock('../src/services/privateGraph.js', async importOriginal => ({...await importOriginal<typeof import('../src/services/privateGraph.js')>(), listThings: mocks.listThings, getThing: mocks.getThing, resolvePrivateThing: mocks.resolvePrivateThing, addNote: mocks.addNote}));
import {extractTripMemory, getTripMemory, saveTripMessage} from '../src/services/tripMemory.js';
import {ImportedChatError} from '../src/services/importedChats.js';
const message = (sourceMessageId: string, text: string) => ({sourceMessageId, text, kind: 'text' as const, mediaType: null});
beforeEach(() => {vi.resetAllMocks(); mocks.getImportedChat.mockResolvedValue({coverage: {complete: false}}); mocks.tripMemoryThingId.mockResolvedValue(null); mocks.bindTripMemoryThing.mockResolvedValue("project"); mocks.listImportedMessages.mockResolvedValue({messages: [], nextCursor: null});});
describe('private trip suggestions', () => {
  it('dedupes tracking links but retains every citation, query identity and credentials boundary', () => {
    const items = extractTripMemory([message('a', 'https://example.com/stay?utm_source=wa&room=1#details'), message('b', 'https://example.com/stay?room=1'), message('c', 'https://example.com/stay?room=2 https://user:secret@example.com/')]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({url: 'https://example.com/stay?room=1', sourceMessageIds: ['a', 'b']});
    expect(JSON.stringify(items)).not.toContain('secret');
  });
  it('keeps candidate language, relative date ambiguity and unavailable media honest', () => {
    const items = extractTripMemory([message('a', "Friday 5 pm at 123 Example Road\nBooked a reservation\nI will bring skis\nWe agreed on the cabin"), {sourceMessageId: 'b', kind: 'media', mediaType: 'image', text: null}]);
    expect(new Set(items.map(item => item.category))).toEqual(new Set(['dates', 'places', 'bookings', 'tasks', 'decisions', 'files']));
    expect(items.find(item => item.category === 'files')?.label).toContain('not imported');
    expect(items.find(item => item.category === 'dates')?.label).toBe('Friday 5 pm at 123 Example Road');
  });
  it('never suggests deleted/system text, including saved deleted messages', () => {
    const items = extractTripMemory([{...message('a', 'https://example.com/'), kind: 'deleted'}, {...message('b', 'https://example.com/'), kind: 'system'}], new Set(['a', 'b']));
    expect(items).toEqual([]);
  });
  it('checks chat ownership before storage or scan, so guessed ids cannot leak', async () => {
    mocks.getImportedChat.mockRejectedValue(new ImportedChatError(404, 'Not found'));
    await expect(getTripMemory('other-owner', 'private-chat')).rejects.toMatchObject({status: 404});
    expect(mocks.tripMemoryThingId).not.toHaveBeenCalled(); expect(mocks.listImportedMessages).not.toHaveBeenCalled();
  });
  it('reads pages and labels bounded scans as partial without writing on GET', async () => {
    mocks.listImportedMessages.mockResolvedValue({messages: Array.from({length: 200}, (_, index) => message(`m${index}`, 'ordinary')), nextCursor: 'next'});
    const result = await getTripMemory('owner', 'chat');
    expect(result).toMatchObject({scannedMessages: 2000, truncated: true});
    expect(mocks.listImportedMessages).toHaveBeenCalledTimes(10); expect(mocks.resolvePrivateThing).not.toHaveBeenCalled(); expect(mocks.addNote).not.toHaveBeenCalled();
  });
  it('reads saved references by immutable id after a rename', async () => {
    mocks.tripMemoryThingId.mockResolvedValue('stable-project');
    mocks.getThing.mockResolvedValue({name: 'Renamed project', notes: [{text: JSON.stringify({openchatTripMemory: 1, chatId: 'chat', sourceMessageId: 'old-source'})}]});
    mocks.getImportedMessage.mockResolvedValue(message('old-source', 'Remember this'));
    const result = await getTripMemory('owner', 'chat');
    expect(result.items).toContainEqual(expect.objectContaining({category: 'saved', sourceMessageIds: ['old-source']}));
    expect(mocks.getThing).toHaveBeenCalledWith('owner', 'stable-project');
    expect(mocks.resolvePrivateThing).not.toHaveBeenCalled();
  });
  it('saves source references only via the established private thing/note service', async () => {
    mocks.getImportedMessage.mockResolvedValue(message('source', 'private source text'));
    mocks.resolvePrivateThing.mockResolvedValue({id: 'project'});
    const by = {author: 'owner', source: 'app', assertion: 'stated'} as const;
    await saveTripMessage('owner', 'chat', {sourceMessageId: 'source'}, by);
    expect(mocks.getImportedMessage).toHaveBeenCalledWith('owner', 'chat', 'source');
    expect(mocks.addNote).toHaveBeenCalledWith('owner', {kind: 'thing', id: 'project'}, JSON.stringify({openchatTripMemory: 1, chatId: 'chat', sourceMessageId: 'source'}), by);
    await expect(saveTripMessage('owner', 'chat', {sourceMessageId: 'source', ownerId: 'someone'}, by)).rejects.toMatchObject({status: 400});
  });
});
