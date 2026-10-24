import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import { describeDesktopUpdate, type DesktopShell } from './desktopShell';

const shell = (update: DesktopShell['update'], autoInstall = true): DesktopShell => ({
  platform: 'macos',
  version: '0.1.24',
  autoInstall,
  update,
});

describe('describeDesktopUpdate', () => {
  it('says the Mac app is current after a successful check', () => {
    expect(describeDesktopUpdate(shell({ state: 'upToDate', checkedAt: '1' }))).toBe('Up to date');
  });

  it('points at the menu item that applies a downloaded update', () => {
    expect(describeDesktopUpdate(shell({ state: 'ready', version: '0.1.25' }))).toBe(
      'Version 0.1.25 installs on next launch — OpenChat menu › Restart to Update',
    );
  });

  it('reports whether updates are automatic before the first check', () => {
    expect(describeDesktopUpdate(shell({ state: 'idle' }, false))).toBe('Automatic updates off');
  });
});
