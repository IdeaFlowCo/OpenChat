import { describe, expect, it } from 'vitest';
import {
  appendVisionRows,
  classifyUnavailable,
  decodeVisionSearchResponse,
  isOpenableVisionUrl,
  mergeStreamItems,
  nextAvailability,
  sortByCreatedAtDesc,
  type VisionSearchRow,
} from './visionSearch';

const row = (id: string, createdAt: string | null, extra: Partial<VisionSearchRow> = {}): VisionSearchRow => ({
  id, text: `text ${id}`, title: null, createdAt, url: `https://vision.ideaflow.app/n/${id}`,
  sourcePlatform: null, sourceLink: null, tags: [], ...extra,
});

describe('decodeVisionSearchResponse', () => {
  it('decodes an ok page', () => {
    const r = decodeVisionSearchResponse({
      status: 'ok', nextCursor: 'c1',
      rows: [{ id: 'a', text: 'hi', title: 'T', createdAt: '2026-10-01T00:00:00Z', url: 'https://vision.ideaflow.app/a', sourcePlatform: 'openchat', sourceLink: null, tags: ['x', 3] }],
    });
    expect(r).toEqual({
      status: 'ok', nextCursor: 'c1',
      rows: [{ id: 'a', text: 'hi', title: 'T', createdAt: '2026-10-01T00:00:00Z', url: 'https://vision.ideaflow.app/a', sourcePlatform: 'openchat', sourceLink: null, tags: ['x'] }],
    });
  });
  it('normalises missing optionals, empty cursor and bad dates', () => {
    const r = decodeVisionSearchResponse({ status: 'ok', nextCursor: null, rows: [{ id: 'a', text: 't', url: 'https://v/a', createdAt: 'nope' }] });
    expect(r).toMatchObject({ status: 'ok', nextCursor: null, rows: [{ title: null, createdAt: null, tags: [], sourcePlatform: null }] });
  });
  it('drops malformed rows but keeps good ones', () => {
    const r = decodeVisionSearchResponse({ status: 'ok', rows: [null, { id: 'x' }, { id: 'a', text: 't', url: 'https://v/a' }] });
    expect(r.status === 'ok' && r.rows.map((x) => x.id)).toEqual(['a']);
  });
  it('decodes unavailable and defaults unknown codes to source_unavailable', () => {
    expect(decodeVisionSearchResponse({ status: 'unavailable', code: 'timeout', reason: 'slow' })).toEqual({ status: 'unavailable', code: 'timeout', reason: 'slow' });
    expect(decodeVisionSearchResponse({ status: 'unavailable', code: 'weird' })).toMatchObject({ code: 'source_unavailable' });
  });
  it.each([null, 'x', 42, {}, { status: 'ok' }, { status: 'ok', rows: 'no' }, { status: 'other' }])('treats malformed payload %j as unavailable', (payload) => {
    expect(decodeVisionSearchResponse(payload)).toMatchObject({ status: 'unavailable', code: 'source_unavailable' });
  });
});

describe('unavailable classification', () => {
  it('treats missing link / config as no Vision, everything else as degraded', () => {
    expect(classifyUnavailable('account_link_required')).toBe('no_vision');
    expect(classifyUnavailable('not_configured')).toBe('no_vision');
    expect(classifyUnavailable('source_unavailable')).toBe('degraded');
    expect(classifyUnavailable('timeout')).toBe('degraded');
  });
  it('availability: ok marks available, no_vision sticks as none, degraded keeps current', () => {
    const ok = decodeVisionSearchResponse({ status: 'ok', rows: [] });
    const noLink = decodeVisionSearchResponse({ status: 'unavailable', code: 'account_link_required', reason: '' });
    const slow = decodeVisionSearchResponse({ status: 'unavailable', code: 'timeout', reason: '' });
    expect(nextAvailability('unknown', ok)).toBe('available');
    expect(nextAvailability('unknown', noLink)).toBe('none');
    expect(nextAvailability('unknown', slow)).toBe('unknown');
    expect(nextAvailability('available', slow)).toBe('available');
  });
});

describe('merge order', () => {
  it('sorts newest first with missing createdAt last, stably', () => {
    const sorted = sortByCreatedAtDesc([
      { id: 'n1', createdAt: null }, { id: 'old', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'n2', createdAt: null }, { id: 'new', createdAt: '2026-06-01T00:00:00Z' },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['new', 'old', 'n1', 'n2']);
  });
  it('interleaves vision rows and local thoughts by createdAt and namespaces ids', () => {
    const merged = mergeStreamItems(
      [row('v1', '2026-03-01T00:00:00Z'), row('v2', null), row('v3', '2026-01-01T00:00:00Z')],
      [{ id: 'same', createdAt: '2026-02-01T00:00:00Z' }, { id: 'v1', createdAt: '2026-04-01T00:00:00Z' }]
    );
    expect(merged.map((m) => m.id)).toEqual(['local:v1', 'vision:v1', 'local:same', 'vision:v3', 'vision:v2']);
    expect(merged.map((m) => m.source)).toEqual(['local', 'vision', 'local', 'vision', 'vision']);
  });
  it('appendVisionRows drops duplicates across pages', () => {
    expect(appendVisionRows([row('a', null), row('b', null)], [row('b', null), row('c', null)]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isOpenableVisionUrl', () => {
  it('allows only https', () => {
    expect(isOpenableVisionUrl('https://vision.ideaflow.app/n/1')).toBe(true);
    expect(isOpenableVisionUrl('http://vision.ideaflow.app')).toBe(false);
    expect(isOpenableVisionUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableVisionUrl('not a url')).toBe(false);
  });
});
