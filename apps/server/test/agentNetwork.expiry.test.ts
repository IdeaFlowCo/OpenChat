import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import { scanIntentForMatches } from '../src/services/agentNetwork.js';

describe('quiet-match expiry exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
  });

  it('does not score or create a match for an expired active candidate', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: (field: string) => ({
          source: {
            id: 'source', ownerUserId: 'source-owner', kind: 'ask',
            terms: 'React accessibility', status: 'active', expiresAt: null,
          },
          candidate: {
            id: 'expired', ownerUserId: 'candidate-owner', kind: 'offer',
            terms: 'React accessibility', status: 'active', expiresAt: '2020-01-01T00:00:00.000Z',
          },
        })[field],
      }],
    });

    const created = await scanIntentForMatches('source', {
      scoring: {
        threshold: 0,
        embeddingScore: async () => null,
        verify: async () => true,
      },
    });

    expect(created).toEqual([]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
