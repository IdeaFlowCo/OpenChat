import { describe, expect, it, vi } from 'vitest';
import { pinThoughtWithReview } from '../src/services/pinThoughtWithReview.js';

describe('pin reviewed-text boundary', () => {
  it('rejects missing or invalid approval before opening a sharing transaction', async () => {
    const session = { executeWrite: vi.fn() };
    for (const text of [undefined, null, 123, 'x'.repeat(20001)]) {
      await expect(pinThoughtWithReview(session as any, 'owner', 'note', 'room', new Date().toISOString(), text as any)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(session.executeWrite).not.toHaveBeenCalled();
  });
});
