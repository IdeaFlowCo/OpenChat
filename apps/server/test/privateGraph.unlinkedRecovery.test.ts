import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), contact: vi.fn(), byHash: vi.fn(), initialize: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({
  run: async () => ({ records: [{ get: () => null }] }), close: async () => undefined,
}) }) }));
vi.mock('../src/services/overlay/store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/overlay/store.js')>('../src/services/overlay/store.js');
  return { ...actual, OverlayStore: class { initialize = mocks.initialize; lookup = mocks.lookup; } };
});
vi.mock('../src/services/unlinkedProvision.js', () => ({ lookupUnlinkedContactForIdentity: mocks.contact, lookupUnlinkedContactsByHash: mocks.byHash }));
import { getUnlinkedPersonOverlay, PrivateGraphError } from '../src/services/privateGraph.js';

const hash = 'a'.repeat(64);
const profile = 'synthetic-public-profile';
const profileRef = `unlinked:person:${profile}`;
const hashRef = `linkedin:in:${hash}`;
const saved = { id: 'saved-private-person', kind: 'person', name: 'Synthetic Person', refs: [hashRef], notes: [], links: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.contact.mockResolvedValue({ ok: true, contact: { connectionId: null, publishedProfileId: profile, linkedinRefHash: hash, name: 'Synthetic Person' } });
  mocks.byHash.mockResolvedValue({ ok: true, contacts: [] });
  mocks.lookup.mockImplementation(async (_principal, ref) => ref === hashRef ? saved : null);
});

describe('Unlinked private-card recovery', () => {
  it('finds a private LinkedIn-bound card from its later published profile, without creating or merging', async () => {
    const card = await getUnlinkedPersonOverlay('synthetic-owner', profile);
    expect(card).toMatchObject({ thingId: saved.id, profileId: profile, linkedinRefHash: hash });
    expect(mocks.contact).toHaveBeenCalledWith(null, { profileId: profile });
    expect(mocks.lookup.mock.calls.map(c => c[1])).toEqual([profileRef, profileRef, hashRef]);
  });

  it('keeps the existing exact-profile fast path independent of upstream availability', async () => {
    mocks.lookup.mockResolvedValue({ ...saved, refs: [profileRef] });
    mocks.contact.mockRejectedValue(new Error('Must not call upstream'));
    expect((await getUnlinkedPersonOverlay('synthetic-owner', profile)).thingId).toBe(saved.id);
    expect(mocks.contact).not.toHaveBeenCalled();
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it('returns inspectable owner candidates when exact URL refs point to different records', async () => {
    mocks.lookup.mockImplementation(async (_principal, ref) => ref === hashRef ? saved : { ...saved, id: 'other-private-person', refs: [profileRef] });
    await expect(getUnlinkedPersonOverlay('synthetic-owner', 'https://www.linkedin.com/in/synthetic-person')).rejects.toMatchObject({
      status: 409, details: { code: 'identity_conflict', candidates: [
        { id: 'other-private-person', thingId: 'other-private-person', kind: 'person', name: 'Synthetic Person' },
        { id: saved.id, thingId: saved.id, kind: 'person', name: 'Synthetic Person' },
      ] },
    });
  });

  it('does not treat a confirmed upstream outage as an empty private card', async () => {
    mocks.lookup.mockResolvedValue(null);
    mocks.contact.mockResolvedValue({ ok: false, code: 'upstream_unavailable' });
    await expect(getUnlinkedPersonOverlay('synthetic-owner', profile)).rejects.toBeInstanceOf(PrivateGraphError);
    await expect(getUnlinkedPersonOverlay('synthetic-owner', profile)).rejects.toMatchObject({ status: 503 });
  });

  it('not-found recovery remains empty and every overlay lookup stays bound to the requesting owner', async () => {
    mocks.lookup.mockResolvedValue(null);
    mocks.contact.mockResolvedValue({ ok: false, code: 'not_found' });
    expect((await getUnlinkedPersonOverlay('owner-one', profile)).thingId).toBeNull();
    const first = mocks.lookup.mock.calls[0]![0].ownerKey;
    expect((await getUnlinkedPersonOverlay('owner-two', profile)).thingId).toBeNull();
    expect(mocks.lookup.mock.calls.at(-1)![0].ownerKey).not.toBe(first);
  });
});

it('retains a local unlinked owner read without disguising missing recovery capability as complete identity', async () => {
  mocks.lookup.mockResolvedValue(null);
  mocks.contact.mockResolvedValue({ ok: false, code: 'not_linked' });
  expect(await getUnlinkedPersonOverlay('synthetic-local-owner', profile)).toMatchObject({
    thingId: null, notes: [], links: [], resolution: { complete: false, reason: 'unlinked_not_linked' },
  });
});
