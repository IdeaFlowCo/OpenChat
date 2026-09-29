import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), executeWrite: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => mocks }) }));

import { changeFriend, FriendError, getFriendStatus, nextFriendConnection, publicFriendState } from '../src/services/friends.js';

const now = '2026-09-29T00:00:00.000Z';
const pending = { state: 'pending' as const, requestedBy: 'alice', requestedTo: 'bob', updatedAt: now };
const accepted = { ...pending, state: 'accepted' as const };

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('friend connection transitions', () => {
  it('is pair-idempotent for duplicate requests and leaves crossed requests incoming', () => {
    expect(nextFriendConnection(null, 'request', 'alice', 'bob', now)).toEqual(pending);
    expect(nextFriendConnection(pending, 'request', 'alice', 'bob', now)).toBe(pending);
    expect(nextFriendConnection(pending, 'request', 'bob', 'alice', now)).toBe(pending);
    expect(publicFriendState(pending, 'bob')).toBe('incoming');
    expect(publicFriendState(pending, 'alice')).toBe('outgoing');
  });

  it('only the recipient accepts or declines; only the sender cancels', () => {
    expect(() => nextFriendConnection(pending, 'accept', 'alice', 'bob', now)).toThrow(FriendError);
    expect(() => nextFriendConnection(pending, 'decline', 'alice', 'bob', now)).toThrow(FriendError);
    expect(() => nextFriendConnection(pending, 'cancel', 'bob', 'alice', now)).toThrow(FriendError);
    expect(nextFriendConnection(pending, 'accept', 'bob', 'alice', now)?.state).toBe('accepted');
    expect(nextFriendConnection(accepted, 'accept', 'bob', 'alice', now)).toBe(accepted);
    expect(nextFriendConnection(pending, 'decline', 'bob', 'alice', now)?.state).toBe('declined');
    expect(nextFriendConnection(pending, 'cancel', 'alice', 'bob', now)?.state).toBe('cancelled');
    const cancelled = nextFriendConnection(pending, 'cancel', 'alice', 'bob', now);
    expect(nextFriendConnection(cancelled, 'cancel', 'alice', 'bob', now)).toBe(cancelled);
    expect(() => nextFriendConnection(null, 'accept', 'bob', 'alice', now)).toThrow(FriendError);
  });

  it('allows either friend to remove and never treats an old DM as friendship', () => {
    expect(nextFriendConnection(accepted, 'remove', 'alice', 'bob', now)?.state).toBe('removed');
    expect(nextFriendConnection(accepted, 'remove', 'bob', 'alice', now)?.state).toBe('removed');
    expect(publicFriendState(null, 'alice')).toBe('none');
    expect(publicFriendState(nextFriendConnection(accepted, 'remove', 'alice', 'bob', now), 'alice')).toBe('none');
  });

  it('throttles the declined sender while allowing the recipient to initiate later', () => {
    const declined = { ...pending, state: 'declined' as const };
    expect(() => nextFriendConnection(declined, 'request', 'alice', 'bob', '2026-09-30T00:00:00.000Z')).toThrowError('Please wait');
    expect(nextFriendConnection(declined, 'request', 'bob', 'alice', now)?.requestedBy).toBe('bob');
    expect(nextFriendConnection(declined, 'request', 'alice', 'bob', '2026-10-07T00:00:00.000Z')?.state).toBe('pending');
  });
});

describe('friend service privacy and pair serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeWrite.mockImplementation(async (callback: (tx: { run: typeof mocks.run }) => unknown) => callback({ run: mocks.run }));
  });

  it('rejects self requests and blocked people before any connection read or write', async () => {
    await expect(changeFriend('alice', 'alice', 'request')).rejects.toMatchObject({ status: 400 });
    expect(mocks.executeWrite).not.toHaveBeenCalled();
    mocks.run.mockImplementation(async (query: string) => query.includes('AS blocked')
      ? { records: [record({ blocked: true, isBot: false, visible: true })] }
      : { records: [] });
    await expect(getFriendStatus('alice', 'bob')).rejects.toMatchObject({ status: 404 });
    await expect(changeFriend('alice', 'bob', 'request')).rejects.toMatchObject({ status: 404 });
    expect(mocks.run.mock.calls.some(([query]) => String(query).includes('MERGE (connection:OpenChatConnection'))).toBe(false);
  });

  it('does not expose hidden strangers through direct user ids', async () => {
    mocks.run.mockImplementation(async (query: string) => query.includes('AS blocked')
      ? { records: [record({ blocked: false, isBot: false, visible: false })] }
      : { records: [] });
    await expect(getFriendStatus('alice', 'hidden')).rejects.toMatchObject({ status: 404 });
    await expect(changeFriend('alice', 'hidden', 'request')).rejects.toMatchObject({ status: 404 });
  });

  it('rechecks the active card token inside the write transaction', async () => {
    mocks.run.mockImplementation(async (query: string) => query.includes('HAS_ADDME_CARD')
      ? { records: [] }
      : { records: [record({ blocked: false, isBot: false, visible: true })] });
    await expect(changeFriend('alice', 'bob', 'request', 'card', true, 'revoked-token'))
      .rejects.toMatchObject({ status: 404 });
    expect(mocks.run.mock.calls.some(([query]) => String(query).includes('MERGE (connection:OpenChatConnection'))).toBe(false);
  });

  it('uses sorted user locks and one pair key, without writing on duplicate or crossed request', async () => {
    mocks.run.mockImplementation(async (query: string) => {
      if (query.includes('AS blocked')) return { records: [record({ blocked: false, isBot: false, visible: true })] };
      if (query.includes('AS connection')) return { records: [record({ connection: pending })] };
      return { records: [] };
    });
    const result = await changeFriend('bob', 'alice', 'request');
    expect(result.state).toBe('incoming');
    expect(mocks.run.mock.calls.some(([query]) => String(query).includes('MERGE (connection:OpenChatConnection'))).toBe(false);
    const pairCall = mocks.run.mock.calls.find(([query]) => String(query).includes('AS connection'));
    expect(pairCall?.[1]).toEqual({ pairKey: '["alice","bob"]' });
    const lockCalls = mocks.run.mock.calls.filter(([query]) => String(query).includes('contextAclRevision'));
    expect(lockCalls.map(([, params]) => params.userId)).toEqual(['alice', 'bob']);
  });
});
