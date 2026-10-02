import { Linking, Share } from 'react-native';
import { addMeCardUrl, api } from '../api/client';

export function cardInviteMessage(url: string): string {
  return `Connect with me on OpenChat: ${url}`;
}

/** Re-read the owner's active token before opening an external share UI. */
export async function currentCardUrl(): Promise<string> {
  return addMeCardUrl((await api.getMyCard()).token);
}

export async function shareCard(url: string): Promise<void> {
  await Share.share({ message: cardInviteMessage(url), url, title: 'OpenChat card' });
}

/** Opens WhatsApp's recipient picker with a draft. The user sends it there. */
export async function shareCardOnWhatsApp(url: string): Promise<void> {
  await Linking.openURL(`https://wa.me/?text=${encodeURIComponent(cardInviteMessage(url))}`);
}
