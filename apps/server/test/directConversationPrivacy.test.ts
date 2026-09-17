import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import {
  DirectConversationNotAllowedError,
  ensureDirectConversation,
} from '../src/services/directConversation.js';

describe('direct conversation privacy', () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockClear();
  });

  it('checks block edges and omits participant emails from the response projection', async () => {
    mocks.run
      .mockResolvedValueOnce({ records: [{ get: () => true }] })
      .mockResolvedValueOnce({
        records: [{
          get: (key: string) => key === 'created'
            ? true
            : { id: 'dm-1', participants: [{ user: { id: 'a', name: 'Alice' } }] },
        }],
      });

    const result = await ensureDirectConversation('a', 'b');

    expect(result.created).toBe(true);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(String(mocks.run.mock.calls[0][0])).toContain('[:BLOCKED]');
    const creationCypher = String(mocks.run.mock.calls[1][0]);
    expect(creationCypher).toContain('.avatarUrl');
    expect(creationCypher).not.toContain('.email');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('refuses a direct conversation when either participant has blocked the other', async () => {
    mocks.run.mockResolvedValueOnce({ records: [{ get: () => false }] });

    await expect(ensureDirectConversation('a', 'b'))
      .rejects.toBeInstanceOf(DirectConversationNotAllowedError);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
