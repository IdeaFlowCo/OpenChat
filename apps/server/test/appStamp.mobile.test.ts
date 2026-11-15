import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { stampTime, relativeStamp, exactStamp } from '../../mobile/src/utils/appStamp';
const require = createRequire(import.meta.url);
const { createStamp } = require('../../mobile/scripts/app-stamp.cjs');
const mocks = vi.hoisted(() => ({ stamp: { version: '1.0.20', commit: 'a'.repeat(40), commitTime: '2026-11-15T12:00:00Z', buildTime: '2026-11-15T13:00:00Z', event: 'commit' } }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: {} }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.20', extra: { appStamp: mocks.stamp } } } }));
import { useAppStamp } from '../../mobile/src/hooks/useAppStamp';

const now = Date.parse('2026-11-15T12:00:00Z');
describe('release stamp provenance and formatting', () => {
  it('uses the committer time on clean rebuilds, recorded build time for dirty and gitless sources', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openchat-stamp-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    try {
      git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
      writeFileSync(join(cwd, 'source'), 'fixture'); git('add', '.'); git('commit', '-m', 'fixture');
      const first = createStamp('1.0.20', { cwd, now: new Date(now) });
      const rebuild = createStamp('1.0.20', { cwd, now: new Date(now + 60000) });
      expect(first.event).toBe('commit'); expect(first.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(rebuild.commitTime).toBe(first.commitTime); expect(rebuild.buildTime).not.toBe(first.buildTime);
      writeFileSync(join(cwd, 'source'), 'dirty');
      expect(createStamp('1.0.20', { cwd }).event).toBe('build');
      rmSync(join(cwd, '.git'), { recursive: true });
      expect(createStamp('1.0.20', { cwd, now: new Date(now) })).toMatchObject({ event: 'build', buildTime: new Date(now).toISOString(), commit: null, commitTime: null });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it.each([[59, 'just now'], [60, '1m ago'], [3599, '59m ago'], [3600, '1h ago'], [86399, '23h ago'], [86400, '1d ago'], [604799, '6d ago']])('formats the boundary at %is', (seconds, expected) => {
    expect(relativeStamp(new Date(now - Number(seconds) * 1000).toISOString(), now)).toBe(expected);
  });
  it('uses calendar dates after seven days, includes old years and handles skew without negative ages', () => {
    expect(relativeStamp(new Date(now - 604800000).toISOString(), now)).toMatch(/Nov.*8|8.*Nov/);
    expect(relativeStamp('2025-11-08T12:00:00Z', now)).toContain('2025');
    expect(relativeStamp(new Date(now + 120000).toISOString(), now)).toBe('just now');
    expect(relativeStamp(new Date(now + 120001).toISOString(), now)).toBe('clock difference');
  });
  it('omits invalid/date-only/missing times and explicitly labels build fallback details', () => {
    for (const commitTime of [null, '', 'invalid', '2026-11-15']) expect(stampTime({ version: '1', event: 'commit', commitTime })).toBeNull();
    expect(stampTime({ version: '1', commitTime: mocks.stamp.commitTime })).toBeNull();
    expect(exactStamp({ ...mocks.stamp, event: 'build' }, mocks.stamp.buildTime)).toMatch(/commit aaaaaaa \(build time\)$/);
    expect(exactStamp({ ...mocks.stamp, event: 'commit' }, mocks.stamp.commitTime)).toContain('2026');
  });
});

describe('stamp visibility clock', () => {
  let tree: ReactTestRenderer;
  let visibility: () => void;
  let doc: { visibilityState: string; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  let stamp: ReturnType<typeof useAppStamp>;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    doc = { visibilityState: 'visible', addEventListener: vi.fn((_, listener) => { visibility = listener; }), removeEventListener: vi.fn() };
    vi.stubGlobal('document', doc);
  });
  afterEach(async () => { if (tree!) await act(async () => tree.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('ticks once per minute only while visible, refreshes on return, and cleans up', async () => {
    function Probe() { stamp = useAppStamp(); return null; }
    await act(async () => { tree = create(React.createElement(Probe)); });
    expect(stamp!.label).toBe('Updated just now'); expect(vi.getTimerCount()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(60000); }); expect(stamp!.label).toBe('Updated 1m ago');
    doc.visibilityState = 'hidden'; await act(async () => visibility()); expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(120000); }); expect(stamp!.label).toBe('Updated 1m ago');
    doc.visibilityState = 'visible'; await act(async () => visibility()); expect(stamp!.label).toBe('Updated 3m ago'); expect(vi.getTimerCount()).toBe(1);
    await act(async () => stamp!.toggle()); expect(stamp!.exact).toBe(true); expect(stamp!.label).toContain('commit aaaaaaa');
    await act(async () => { tree.unmount(); }); expect(vi.getTimerCount()).toBe(0); expect(doc.removeEventListener).toHaveBeenCalled();
  });
});
