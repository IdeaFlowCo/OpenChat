import { describe, expect, it } from 'vitest';
import type { ConversationResource } from '../api/client';
import { filterResources, kindCounts, NO_FILTER, parseTagInput, resourceTitle, sharedLine } from './conversationResources';

const resource = (overrides: Partial<ConversationResource>): ConversationResource => ({
  id: 'r', url: 'https://example.org/a', host: 'example.org', kind: 'link', kindEdited: false, title: null, description: null, siteName: null, tags: [], suggestedTags: [], tagsEdited: false,
  firstSharedAt: '2026-11-09T12:00:00.000Z', lastSharedAt: '2026-11-09T12:00:00.000Z', firstSharedBy: { label: 'Ada Example', userId: null }, shareCount: 1, sources: ['imessage'], saved: false, savedCount: 0, ...overrides,
});
const paper = resource({ id: 'paper', kind: 'paper', title: 'Shared Knowledge Graphs', tags: ['research', 'hci'], saved: true });
const person = resource({ id: 'person', kind: 'person', host: 'ada.example.edu', url: 'https://ada.example.edu/', tags: ['researcher'] });
const tool = resource({ id: 'tool', kind: 'paper', description: 'A note-taking tool', url: 'https://www.example.com/tool/' });
const all = [paper, person, tool];

describe('link resource filters', () => {
  it('filters by saved, kind, tag and free text together', () => {
    expect(filterResources(all, NO_FILTER)).toHaveLength(3);
    expect(filterResources(all, { ...NO_FILTER, saved: true }).map(r => r.id)).toEqual(['paper']);
    expect(filterResources(all, { ...NO_FILTER, kind: 'paper' }).map(r => r.id)).toEqual(['paper', 'tool']);
    expect(filterResources(all, { ...NO_FILTER, tag: 'researcher' }).map(r => r.id)).toEqual(['person']);
    expect(filterResources(all, { ...NO_FILTER, query: ' #HCI ' }).map(r => r.id)).toEqual(['paper']);
    expect(filterResources(all, { ...NO_FILTER, query: 'note-taking' }).map(r => r.id)).toEqual(['tool']);
    expect(filterResources(all, { ...NO_FILTER, query: 'person' }).map(r => r.id)).toEqual(['person']);
    expect(filterResources(all, { ...NO_FILTER, kind: 'paper', saved: true, query: 'graphs' }).map(r => r.id)).toEqual(['paper']);
    expect(filterResources(all, { ...NO_FILTER, query: 'nothing matches' })).toEqual([]);
  });
  it('counts kinds, most common first', () => {
    expect(kindCounts(all)).toEqual([{ kind: 'paper', count: 2 }, { kind: 'person', count: 1 }]);
  });
});

describe('link resource wording', () => {
  it('titles a link by its page title, else by its address without the scheme', () => {
    expect(resourceTitle(paper)).toBe('Shared Knowledge Graphs');
    expect(resourceTitle(tool)).toBe('example.com/tool');
  });
  it('reads typed tags leniently', () => {
    expect(parseTagInput(' #HCI, research  hci,,tools-for-thought ')).toEqual(['hci', 'research', 'tools-for-thought']);
    expect(parseTagInput('  ')).toEqual([]);
  });
  it('says who first shared it, where and how often', () => {
    expect(sharedLine(paper)).toMatch(/^Shared by Ada Example · .+ · iMessage$/);
    expect(sharedLine(resource({ firstSharedBy: { label: 'Owner Account', userId: 'owner' }, sources: ['imessage', 'openchat'], shareCount: 3 }), 'owner')).toMatch(/^Shared by you · .+ · iMessage and OpenChat · 3 times$/);
    expect(sharedLine(resource({ firstSharedBy: { label: null, userId: null }, firstSharedAt: null, sources: [] }))).toBe('Shared');
  });
});
