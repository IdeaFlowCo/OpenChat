import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-contacts', () => { throw new Error('Cannot find native module ExpoContacts'); });

it('loads safely in an older binary and offers unavailable fallback', async () => {
  const { getContactAccess } = await import('./deviceContactInvite');
  expect(await getContactAccess()).toBe('unavailable');
  expect(await getContactAccess(true)).toBe('unavailable');
});
