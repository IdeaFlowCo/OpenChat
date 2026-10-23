import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
// Release builds report a module that throws while loading as fatal before
// import() can reject, so the package must never be loaded at all.
const loaded = vi.hoisted(() => ({ contacts: false }));
vi.mock('expo-contacts', () => {
  loaded.contacts = true;
  throw new Error('Cannot find native module ExpoContacts');
});

it('loads safely in an older binary and offers unavailable fallback', async () => {
  const { getContactAccess } = await import('./deviceContactInvite');
  expect(await getContactAccess()).toBe('unavailable');
  expect(await getContactAccess(true)).toBe('unavailable');
  expect(loaded.contacts).toBe(false);
});
