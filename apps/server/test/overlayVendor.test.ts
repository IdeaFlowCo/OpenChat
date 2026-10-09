import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The overlay's semantics have one owner: Noos src/overlay. OpenChat runs an
// identical copy in-process. These hashes are written only by
// scripts/vendor-noos-overlay.mjs from a clean Noos checkout, so an edit made
// here instead of in Noos fails CI.
describe('vendored Noos overlay', () => {
  const dir = join(import.meta.dirname, '../src/services/overlay');
  const pin = JSON.parse(readFileSync(join(dir, 'NOOS_SOURCE.json'), 'utf8')) as { repository: string; commit: string; files: Record<string, string> };

  it('is pinned to a Noos commit', () => {
    expect(pin.repository).toBe('IdeaFlowCo/noos');
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.files).sort()).toEqual(['contract.ts', 'store.ts']);
  });

  it.each(['contract.ts', 'store.ts'])('%s is byte-identical to the pinned Noos file', name => {
    expect(createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')).toBe(pin.files[name]);
  });
});
