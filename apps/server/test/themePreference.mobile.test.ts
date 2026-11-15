import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../../mobile/src/contexts/ThemeContext';

const mocks = vi.hoisted(() => ({
  scheme: 'dark' as 'light' | 'dark' | null,
  getItem: vi.fn(),
  setItem: vi.fn(async () => {}),
}));
vi.mock('react-native', () => ({ useColorScheme: () => mocks.scheme }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: mocks.getItem, setItem: mocks.setItem,
} }));

let theme: ReturnType<typeof useTheme>;
let tree: ReactTestRenderer;
function Probe() { theme = useTheme(); return null; }
const render = () => React.createElement(ThemeProvider, null, React.createElement(Probe));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.scheme = 'dark';
  mocks.getItem.mockReset().mockResolvedValue(null);
  mocks.setItem.mockClear();
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });

async function mount() { await act(async () => { tree = create(render()); }); }

// Mock the OS/storage boundaries, exercising the actual provider and hooks.
describe('theme preference defaults and migration', () => {
  it('follows the system immediately, before storage resolves', async () => {
    let resolve!: (value: null) => void;
    mocks.getItem.mockImplementation(() => new Promise(r => { resolve = r; }));
    await mount();
    expect(theme.preference).toBe('system');
    expect(theme.scheme).toBe('dark');
    await act(async () => { resolve(null); });
    expect(theme.scheme).toBe('dark');
  });

  it('migrates an unset preference without writing an explicit choice', async () => {
    await mount();
    expect(mocks.getItem).toHaveBeenCalledWith('openchat_theme_pref');
    expect(theme.preference).toBe('system');
    expect(mocks.setItem).not.toHaveBeenCalled();
    mocks.scheme = 'light';
    await act(async () => { tree.update(render()); });
    expect(theme.scheme).toBe('light');
  });

  it.each(['light', 'dark', 'system'] as const)('preserves an explicit %s preference', async preference => {
    mocks.getItem.mockResolvedValue(preference);
    await mount();
    expect(theme.preference).toBe(preference);
    expect(theme.scheme).toBe(preference === 'system' ? 'dark' : preference);
    mocks.scheme = 'light';
    await act(async () => { tree.update(render()); });
    expect(theme.scheme).toBe(preference === 'system' ? 'light' : preference);
    expect(mocks.setItem).not.toHaveBeenCalled();
  });

  it('keeps Light and Dark selectable, persists them, and can return to System', async () => {
    await mount();
    for (const preference of ['light', 'dark', 'system'] as const) {
      await act(async () => { await theme.setPreference(preference); });
      expect(theme.preference).toBe(preference);
      expect(theme.scheme).toBe(preference === 'system' ? 'dark' : preference);
      expect(mocks.setItem).toHaveBeenLastCalledWith('openchat_theme_pref', preference);
    }
  });

  it('falls back to System for invalid storage or a read failure', async () => {
    mocks.getItem.mockResolvedValue('invalid');
    await mount();
    expect(theme.preference).toBe('system');
    await act(async () => tree.unmount());
    mocks.getItem.mockRejectedValue(new Error('storage unavailable'));
    await mount();
    expect(theme.preference).toBe('system');
    expect(theme.scheme).toBe('dark');
  });

  it('uses light when the OS reports no preference', async () => {
    mocks.scheme = null;
    await mount();
    expect(theme.preference).toBe('system');
    expect(theme.scheme).toBe('light');
  });
});

it('preserves the stored Paper palette while following the system scheme', async () => {
  mocks.getItem.mockImplementation(async key => key === 'openchat_look' ? 'paper' : 'system');
  await mount(); expect(theme.look).toBe('paper'); expect(theme.scheme).toBe('dark');
  expect(mocks.setItem).not.toHaveBeenCalled();
  await act(async () => tree.unmount()); await mount(); expect(theme.look).toBe('paper');
});
