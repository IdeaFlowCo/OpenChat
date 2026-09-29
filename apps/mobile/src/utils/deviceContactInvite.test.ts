import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  getPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  picker: vi.fn(),
  more: vi.fn(),
  platform: { OS: 'ios' },
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-contacts', () => ({
  isAvailableAsync: mocks.available,
  getPermissionsAsync: mocks.getPermissions,
  requestPermissionsAsync: mocks.requestPermissions,
  presentContactPickerAsync: mocks.picker,
  presentAccessPickerAsync: mocks.more,
}));

import { allowMoreContacts, chooseOneContact, contactAccessFromPermission, getContactAccess } from './deviceContactInvite';

describe('single-contact invitation access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.OS = 'ios';
    mocks.available.mockResolvedValue(true);
  });

  it.each([
    [{ status: 'undetermined' }, 'not_requested'],
    [{ status: 'granted', accessPrivileges: 'all' }, 'all'],
    [{ status: 'granted', accessPrivileges: 'limited' }, 'limited'],
    [{ status: 'granted', accessPrivileges: 'none' }, 'denied'],
    [{ status: 'denied' }, 'denied'],
  ] as const)('maps permission %j to %s', (permission, state) => {
    expect(contactAccessFromPermission(permission)).toBe(state);
  });

  it('checks native access without prompting until an explicit action requests it', async () => {
    mocks.getPermissions.mockResolvedValue({ status: 'undetermined' });
    mocks.requestPermissions.mockResolvedValue({ status: 'granted', accessPrivileges: 'limited' });
    expect(await getContactAccess()).toBe('not_requested');
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    expect(await getContactAccess(true)).toBe('limited');
    expect(mocks.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('handles web and unavailable native modules without reading contacts', async () => {
    mocks.platform.OS = 'web';
    expect(await getContactAccess(true)).toBe('unavailable');
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    mocks.platform.OS = 'ios';
    mocks.available.mockResolvedValue(false);
    expect(await getContactAccess(true)).toBe('unavailable');
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
  });

  it('keeps only a display name from one OS-selected contact', async () => {
    mocks.picker.mockResolvedValue({ id: 'private-id', name: 'Ada Lovelace', phoneNumbers: [{ number: '+15555550123' }] });
    expect(await chooseOneContact()).toBe('Ada Lovelace');
    mocks.picker.mockResolvedValue(null);
    expect(await chooseOneContact()).toBeNull();
  });

  it('reopens iOS limited access selection and rereads current access', async () => {
    mocks.more.mockResolvedValue(['private-id']);
    mocks.getPermissions.mockResolvedValue({ status: 'granted', accessPrivileges: 'limited' });
    expect(await allowMoreContacts()).toBe('limited');
    expect(mocks.more).toHaveBeenCalledTimes(1);
    expect(mocks.getPermissions).toHaveBeenCalledTimes(1);
  });
});
