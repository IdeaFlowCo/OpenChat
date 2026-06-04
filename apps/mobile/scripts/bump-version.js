#!/usr/bin/env node
/**
 * bump-version.js (OpenChat-601.3)
 *
 * Bumps the patch version of app.config.js for the next EAS build. Replaces
 * the previous one-liner pattern that mutated app.json (which no longer
 * exists after OpenChat-601 part 2).
 *
 * Usage:
 *   node scripts/bump-version.js            # bump patch (default)
 *   node scripts/bump-version.js minor      # bump minor (0.1.4 → 0.2.0)
 *   node scripts/bump-version.js major      # bump major (0.1.4 → 1.0.0)
 *   node scripts/bump-version.js --dry-run  # show what would change
 *
 * The script edits app.config.js in place via targeted regex (single-quoted
 * version: '…' literal). It refuses to run if the regex can't find exactly
 * one match — better to fail loudly than silently mis-edit.
 *
 * iOS buildNumber is left alone — EAS' production profile has
 * autoIncrement:true, so the buildNumber is incremented per-build by EAS
 * itself.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const part = args.find((a) => ['patch', 'minor', 'major'].includes(a)) || 'patch';
const dryRun = args.includes('--dry-run');

const cfgPath = path.join(__dirname, '..', 'app.config.js');
const src = fs.readFileSync(cfgPath, 'utf8');

// Match `version: '0.1.4'` exactly — single-quoted literal.
const matches = src.match(/version:\s*'(\d+)\.(\d+)\.(\d+)'/g) || [];
if (matches.length !== 1) {
  console.error(`bump-version: expected exactly 1 version literal in app.config.js, found ${matches.length}`);
  console.error('  refusing to edit — check the file format');
  process.exit(2);
}

const re = /version:\s*'(\d+)\.(\d+)\.(\d+)'/;
const m = src.match(re);
const [, maj, min, pat] = m;

let newVersion;
if (part === 'major')      newVersion = `${Number(maj) + 1}.0.0`;
else if (part === 'minor') newVersion = `${maj}.${Number(min) + 1}.0`;
else                       newVersion = `${maj}.${min}.${Number(pat) + 1}`;

const oldVersion = `${maj}.${min}.${pat}`;

if (dryRun) {
  console.log(`bump-version (dry run): ${oldVersion} → ${newVersion} (${part})`);
  process.exit(0);
}

const updated = src.replace(re, `version: '${newVersion}'`);
fs.writeFileSync(cfgPath, updated, 'utf8');
console.log(`${oldVersion} → ${newVersion}`);
