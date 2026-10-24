// OpenChat for Mac (apps/desktop) is a native shell around this web client.
// The shell injects `window.__OPENCHAT_DESKTOP__` with its own version and
// auto-update state, and fires `openchat-desktop-update` whenever that changes.
// Outside the Mac app this is always null.
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

export type DesktopUpdateStatus =
  | { state: 'idle' | 'checking' }
  | { state: 'upToDate' | 'failed'; checkedAt: string }
  | { state: 'available' | 'downloading' | 'ready'; version: string };

export type DesktopShell = {
  platform: 'macos';
  version: string;
  autoInstall: boolean;
  update: DesktopUpdateStatus;
};

const EVENT = 'openchat-desktop-update';

function read(): DesktopShell | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const shell = (window as unknown as { __OPENCHAT_DESKTOP__?: DesktopShell }).__OPENCHAT_DESKTOP__;
  return shell && typeof shell.version === 'string' ? shell : null;
}

function subscribe(onChange: () => void) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

export function useDesktopShell(): DesktopShell | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function describeDesktopUpdate(shell: DesktopShell): string {
  const { update } = shell;
  switch (update.state) {
    case 'upToDate':
      return 'Up to date';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${update.version} available — OpenChat menu › Check for Updates…`;
    case 'downloading':
      return `Downloading version ${update.version}…`;
    case 'ready':
      return `Version ${update.version} installs on next launch — OpenChat menu › Restart to Update`;
    case 'failed':
      return 'Couldn’t check for updates';
    default:
      return shell.autoInstall ? 'Updates install automatically' : 'Automatic updates off';
  }
}
