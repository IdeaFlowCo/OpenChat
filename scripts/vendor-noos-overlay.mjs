#!/usr/bin/env node
// Re-vendor the Noos people-overlay core (contract.ts, store.ts) byte-for-byte
// and pin it: node scripts/vendor-noos-overlay.mjs <path-to-noos-checkout>
// The checkout must be clean at the commit being pinned. CI checks the hashes
// (apps/server/test/overlayVendor.test.ts), so the vendored files cannot drift
// from the pinned Noos commit without this script being re-run.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILES = ['contract.ts', 'store.ts'];
const noos = process.argv[2];
if (!noos) { console.error('usage: node scripts/vendor-noos-overlay.mjs <path-to-noos-checkout>'); process.exit(2); }
const git = (...args) => execFileSync('git', ['-C', noos, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--', 'src/overlay')) { console.error('Noos src/overlay has uncommitted changes; commit first'); process.exit(1); }
const target = resolve(import.meta.dirname, '../apps/server/src/services/overlay');
const files = {};
for (const name of FILES) {
  copyFileSync(join(noos, 'src/overlay', name), join(target, name));
  files[name] = createHash('sha256').update(readFileSync(join(target, name))).digest('hex');
}
const pin = { repository: 'IdeaFlowCo/noos', path: 'src/overlay', commit: git('rev-parse', 'HEAD'), files };
writeFileSync(join(target, 'NOOS_SOURCE.json'), `${JSON.stringify(pin, null, 2)}\n`);
console.log(`Vendored ${FILES.join(', ')} from noos ${pin.commit}`);
