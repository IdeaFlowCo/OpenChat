// Build provenance only; never changes native version, runtime or dependencies.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function createStamp(version, { cwd = path.resolve(__dirname, '../../..'), now = new Date(), git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } = {}) {
  const stamp = { version, commit: null, commitTime: null, buildTime: now.toISOString(), event: 'build' };
  try {
    stamp.commit = git(['rev-parse', 'HEAD']);
    stamp.commitTime = git(['log', '-1', '--format=%cI', 'HEAD']);
    if (!git(['status', '--porcelain']) && Number.isFinite(Date.parse(stamp.commitTime))) stamp.event = 'commit';
  } catch { /* Source archives without git use the recorded build time. */ }
  return stamp;
}

function readStamp(version) {
  if (!process.env.OPENCHAT_STAMP_FILE) return createStamp(version);
  const stamp = JSON.parse(fs.readFileSync(process.env.OPENCHAT_STAMP_FILE, 'utf8'));
  if (stamp.version !== version || !['commit', 'build'].includes(stamp.event)
      || !Number.isFinite(Date.parse(stamp.buildTime))
      || (stamp.event === 'commit' && (!/^[a-f0-9]{40}$/.test(stamp.commit) || !Number.isFinite(Date.parse(stamp.commitTime))))) {
    throw new Error('Invalid OpenChat build stamp');
  }
  return stamp;
}
module.exports = { createStamp, readStamp };
