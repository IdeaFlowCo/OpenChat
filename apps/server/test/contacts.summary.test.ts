import { beforeEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ listPage: vi.fn(), get: vi.fn() }));
vi.mock('../src/services/overlay/store.js', async () => ({
  ...await vi.importActual('../src/services/overlay/store.js'),
  OverlayStore: class {
    initialize = async () => {};
    listPage = store.listPage;
    get = store.get;
  },
}));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({
  run: async () => ({ records: [{ get: () => null }] }), close: async () => {},
}) }) }));
import { listThings, getThing, readContactState } from '../src/services/privateGraph.js';
const payload = { schemaVersion: 1, native: { notes: 'x'.repeat(260000), unknown: [1, { future: true }] } };
const card = { important: true, cadenceMode: 'fixed', cadenceDays: null, intervalDays: null, lastContactAt: null, nextDueAt: null };
const entity = (id = 'synthetic-person') => ({ id, kind: 'person', name: 'Synthetic', description: 'Saved person', card, refs: [],
  peopleState: { schemaVersion: 1, revision: 2, payload, actorId: 'grant:one' } });
const contactSources = [{ source: 'Synthetic', sourceId: 'one', name: 'Independent source name', data: payload }];
beforeEach(() => { vi.clearAllMocks(); });

it('returns bounded summaries for every page without returning opaque state or sources', async () => {
  store.listPage.mockImplementation(async (_principal, filter) => {
    expect(filter.details).toBe(false);
    const offset = Number(filter.after ?? 0), end = Math.min(offset + Number(filter.limit), 5007);
    return { entities: Array.from({ length: end - offset }, (_, i) => ({ ...entity(String(offset + i)), contactSources })),
      total: 5007, nextCursor: end < 5007 ? String(end) : null };
  });
  let cursor: string | null = null, bytes = 0;
  const ids = new Set<string>();
  do {
    const page = await listThings('synthetic-owner', '', 'person', { summary: 'true', details: 'true', limit: 100, ...(cursor ? { after: cursor } : {}) });
    expect(page.total).toBe(5007);
    for (const row of page.things) {
      expect(row).toEqual({ id: expect.any(String), kind: 'person', name: 'Synthetic', description: 'Saved person', card });
      ids.add(row.id);
    }
    bytes += Buffer.byteLength(JSON.stringify(page));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids.size).toBe(5007);
  expect(store.listPage).toHaveBeenCalledTimes(51);
  expect(bytes).toBeLessThan(2 * 1024 * 1024);
});

it('preserves full default, synchronization, detail and contact-state payloads', async () => {
  store.listPage.mockImplementation(async (_principal, filter) => ({ entities: [filter.details
    ? { ...entity(), notes: [], links: [], contactSources } : entity()], total: 1, nextCursor: null }));
  store.get.mockResolvedValue({ ...entity(), notes: [], links: [], contactSources });
  const normal = await listThings('synthetic-owner', '', 'person');
  expect(normal.things[0]).toHaveProperty('peopleState.payload', payload);
  expect(normal.things[0]).not.toHaveProperty('contactSources');
  const synchronized = await listThings('synthetic-owner', '', 'person', { details: 'true' });
  for (const result of [synchronized.things[0], await getThing('synthetic-owner', 'synthetic-person'), await readContactState('synthetic-owner', 'synthetic-person')]) {
    expect(result).toHaveProperty('peopleState.payload', payload);
    expect(result).toHaveProperty('contactSources', contactSources);
  }
});
