import { describe, expect, it } from 'vitest';
import { doiFromUrl, extractResourceUrls, inferResource, normalizeResourceUrl, normalizeTags, ResourceInputError } from '../src/services/resourceInference.js';

describe('link resources: addresses', () => {
  it('finds every distinct address and trims sentence punctuation', () => {
    expect(extractResourceUrls('see https://example.org/a, then (https://example.org/b). Again https://example.org/a!')).toEqual(['https://example.org/a', 'https://example.org/b']);
    const many = Array.from({ length: 15 }, (_, i) => `https://example.org/${i}`);
    expect(extractResourceUrls(many.join(' '))).toEqual(many);
    expect(extractResourceUrls(null)).toEqual([]);
    expect(extractResourceUrls('no links here')).toEqual([]);
  });

  it('treats scheme, www, trailing slash, fragment and tracking parameters as the same page', () => {
    const keys = ['http://www.Example.org/path/', 'https://example.org/path#section', 'https://example.org/path?utm_source=x&fbclid=1'].map(url => normalizeResourceUrl(url)!.urlKey);
    expect(new Set(keys)).toEqual(new Set(['example.org/path']));
    expect(normalizeResourceUrl('https://example.org/?b=2&a=1')!.urlKey).toBe('example.org/?a=1&b=2');
    expect(normalizeResourceUrl('https://example.org/a')!.urlKey).not.toBe(normalizeResourceUrl('https://example.org/b')!.urlKey);
  });

  it('refuses addresses that are not plain public http links', () => {
    for (const url of ['javascript:alert(1)', 'ftp://example.org/x', 'https://user:pass@example.org/', 'http://localhost/x', 'not a url']) expect(normalizeResourceUrl(url)).toBeNull();
  });
});

describe('link resources: what a link is', () => {
  const kind = (url: string, title?: string, description?: string) => inferResource({ url, title, description });

  it('recognises papers, references, people, code, video and documents from the address', () => {
    expect(kind('https://dl.acm.org/doi/10.1145/1234567')).toMatchObject({ kind: 'paper', suggestedTags: expect.arrayContaining(['paper', 'research', 'acm']) });
    expect(kind('https://arxiv.org/abs/2401.00001').kind).toBe('paper');
    expect(kind('https://en.wikipedia.org/wiki/Giant_Global_Graph')).toMatchObject({ kind: 'reference', suggestedTags: expect.arrayContaining(['wikipedia', 'giant-global-graph', 'semantic-web']) });
    expect(kind('https://www.w3.org/DesignIssues/Abstractions.html')).toMatchObject({ kind: 'reference', suggestedTags: expect.arrayContaining(['w3c']) });
    expect(kind('https://someone.example.edu/')).toMatchObject({ kind: 'person', suggestedTags: expect.arrayContaining(['researcher', 'example']) });
    expect(kind('https://someone.github.io/')).toMatchObject({ kind: 'person', suggestedTags: ['homepage'] });
    expect(kind('https://github.com/acme/widget')).toMatchObject({ kind: 'code', suggestedTags: expect.arrayContaining(['code', 'widget']) });
    expect(kind('https://youtu.be/abc').kind).toBe('video');
    expect(kind('https://docs.google.com/document/d/abc').kind).toBe('document');
    expect(kind('https://lu.ma/some-event').kind).toBe('event');
  });

  it('uses the page title and description when the address says little', () => {
    expect(kind('https://example.com/', 'Acme, a note-taking app', 'Sign up for the beta')).toMatchObject({ kind: 'tool', suggestedTags: expect.arrayContaining(['tool', 'beta', 'tools-for-thought']) });
    expect(kind('https://garden-community.example.org/')).toMatchObject({ kind: 'community', suggestedTags: expect.arrayContaining(['community']) });
    expect(kind('https://example.com/engelbart/beta').kind).toBe('tool');
    expect(kind('https://example.com/some/long/path')).toEqual({ kind: 'link', suggestedTags: [] });
  });

  it('suggests at most five tags, each a valid tag', () => {
    const guess = kind('https://example.ai/', 'AI research community archive for open source knowledge graph design startups', 'chat with founders');
    expect(guess.suggestedTags.length).toBeLessThanOrEqual(5);
    expect(normalizeTags(guess.suggestedTags)).toEqual(guess.suggestedTags);
  });
});

describe('link resources: DOIs', () => {
  it('reads the DOI from doi.org and publisher addresses, and from nothing else', () => {
    expect(doiFromUrl('https://doi.org/10.1145/1234567')).toBe('10.1145/1234567');
    expect(doiFromUrl('https://dl.acm.org/doi/10.1145/1234567#abstract')).toBe('10.1145/1234567');
    expect(doiFromUrl('https://dl.acm.org/doi/pdf/10.1145/1234567.1234568')).toBe('10.1145/1234567.1234568');
    expect(doiFromUrl('https://www.example.com/blog/10.1145/1234567')).toBeNull();
    expect(doiFromUrl('https://example.org/about')).toBeNull();
    expect(doiFromUrl('not a url')).toBeNull();
  });
});

describe('link resources: tags a member types', () => {
  it('normalises case, hashes, spaces and duplicates', () => {
    expect(normalizeTags([' #HCI ', 'tools for thought', 'hci', '', 'Ｒesearch'])).toEqual(['hci', 'tools-for-thought', 'research']);
  });
  it('rejects anything that is not a plain tag', () => {
    for (const bad of [['<script>'], ['a/b'], ['x'.repeat(41)], [3], 'hci', Array.from({ length: 13 }, (_, i) => `t${i}`)]) {
      expect(() => normalizeTags(bad as unknown)).toThrow(ResourceInputError);
    }
  });
});


it('prefers Crossref metadata for a DOI and falls back to its page', async () => {
  const { fetchResourcePreview } = await import('../src/services/conversationResources.js');
  const page = async () => ({ title: 'Generic page' });
  expect(await fetchResourcePreview('https://doi.org/10.1145/1111111', page, async () => ({ title: 'Paper title' }))).toEqual({ title: 'Paper title' });
  expect(await fetchResourcePreview('https://doi.org/10.1145/1111111', page, async () => null)).toEqual({ title: 'Generic page' });
});
