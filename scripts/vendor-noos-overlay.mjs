#!/usr/bin/env node
// Re-vendor the Noos people-overlay core (contract.ts, store.ts) byte-for-byte
// and pin it: node scripts/vendor-noos-overlay.mjs <path-to-noos-checkout> [ref]
// Without an explicit ref the checkout must be clean. An explicit ref reads immutable Git blobs. CI checks the hashes
// (apps/server/test/overlayVendor.test.ts), so the vendored files cannot drift
// from the pinned Noos commit without this script being re-run.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILES = ['contract.ts', 'store.ts'];
const noos = process.argv[2];
if (!noos) { console.error('usage: node scripts/vendor-noos-overlay.mjs <path-to-noos-checkout> [ref]'); process.exit(2); }
const git = (...args) => execFileSync('git', ['-C', noos, ...args], { encoding: 'utf8' }).trim();
const sourceRef = process.argv[3] || 'HEAD';
const commit = git('rev-parse', '--verify', `${sourceRef}^{commit}`);
if (!process.argv[3] && git('status', '--porcelain', '--', 'src/overlay')) { console.error('Noos src/overlay has uncommitted changes; commit first'); process.exit(1); }
const target = resolve(import.meta.dirname, '../apps/server/src/services/overlay');
const files = {};
for (const name of FILES) {
  const source = execFileSync('git', ['-C', noos, 'show', `${commit}:src/overlay/${name}`]);
  writeFileSync(join(target, name), source);
  files[name] = createHash('sha256').update(source).digest('hex');
}
const pin = { repository: 'IdeaFlowCo/noos', path: 'src/overlay', commit, files };
writeFileSync(join(target, 'NOOS_SOURCE.json'), `${JSON.stringify(pin, null, 2)}\n`);
console.log(`Vendored ${FILES.join(', ')} from noos ${pin.commit}`);
