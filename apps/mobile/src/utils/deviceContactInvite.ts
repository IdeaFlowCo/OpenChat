import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';

export type ContactAccess = 'unavailable' | 'not_requested' | 'all' | 'limited' | 'denied';

export function contactAccessFromPermission(permission: {
  status: string;
  accessPrivileges?: 'all' | 'limited' | 'none';
}): ContactAccess {
  if (permission.status === 'undetermined') return 'not_requested';
  if (permission.status !== 'granted' || permission.accessPrivileges === 'none') return 'denied';
  return permission.accessPrivileges === 'limited' ? 'limited' : 'all';
}

export async function getContactAccess(request = false): Promise<ContactAccess> {
  if (Platform.OS === 'web' || !(await Contacts.isAvailableAsync())) return 'unavailable';
  const permission = request
    ? await Contacts.requestPermissionsAsync()
    : await Contacts.getPermissionsAsync();
  return contactAccessFromPermission(permission);
}

/** The OS returns a contact record; retain only its display name in screen
 * memory for the invitation preview. No address-book identifier or field is
 * sent to OpenChat, persisted, or placed in the outgoing message. */
export async function chooseOneContact(): Promise<string | null> {
  const contact = await Contacts.presentContactPickerAsync();
  if (!contact) return null;
  return (contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ')).trim() || 'Selected contact';
}

export async function allowMoreContacts(): Promise<ContactAccess> {
  await Contacts.presentAccessPickerAsync();
  return getContactAccess();
}
