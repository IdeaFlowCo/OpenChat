import { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { addMeCardUrl, api, type MyAddMeCard } from '../api/client';
import { AddMeCardView } from '../components/AddMeCardView';
import { cardInviteMessage, shareCard, shareCardOnWhatsApp } from '../utils/cardSharing';
import { allowMoreContacts, chooseOneContact, getContactAccess, type ContactAccess } from '../utils/deviceContactInvite';
import type { NavProp } from '../navigation/types';

export function InvitePersonScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser } = useChat();
  const navigation = useNavigation<NavProp<'InvitePerson'>>();
  const accountRef = useRef(currentUser?.userId);
  accountRef.current = currentUser?.userId;
  const [access, setAccess] = useState<ContactAccess>('not_requested');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [card, setCard] = useState<MyAddMeCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A different signed-in account must never see the prior account's link or
  // selected device contact. The contact name also clears on navigation away.
  useFocusEffect(useCallback(() => {
    let active = true;
    setSelectedName(null);
    setCard(null);
    setError(null);
    if (currentUser) {
      api.getMyCard()
        .then(next => { if (active) setCard(next); })
        .catch(() => { if (active) setError('Could not load your card link.'); });
    }
    getContactAccess()
      .then(next => { if (active) setAccess(next); })
      .catch(() => { if (active) setAccess('unavailable'); });
    return () => { active = false; setSelectedName(null); };
  }, [currentUser?.userId]));

  const choose = async () => {
    const accountId = accountRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await getContactAccess(access === 'not_requested');
      if (accountRef.current !== accountId) return;
      setAccess(next);
      if (next === 'all' || next === 'limited') {
        const name = await chooseOneContact();
        if (accountRef.current === accountId) setSelectedName(name);
      }
    } catch {
      setAccess('unavailable');
      setError('Contacts are unavailable in this app build. You can still share your link.');
    } finally {
      setBusy(false);
    }
  };

  const more = async () => {
    setBusy(true);
    try {
      setAccess(await allowMoreContacts());
      setSelectedName(null);
    } catch {
      setError('Could not open the contact access picker. Try again or share your link.');
    } finally {
      setBusy(false);
    }
  };

  const handoff = async (channel: 'share' | 'whatsapp' | 'copy') => {
    const accountId = accountRef.current;
    setBusy(true);
    setError(null);
    try {
      // The preview may have been open during token rotation on another device.
      const latestCard = await api.getMyCard();
      if (accountRef.current !== accountId) return;
      setCard(latestCard);
      const latestUrl = addMeCardUrl(latestCard.token);
      if (channel === 'share') await shareCard(latestUrl);
      else if (channel === 'whatsapp') await shareCardOnWhatsApp(latestUrl);
      else {
        await Clipboard.setStringAsync(latestUrl);
        setCopied(true);
      }
      setSelectedName(null);
    } catch {
      setError('Could not open sharing. Try Copy link instead.');
    } finally {
      setBusy(false);
    }
  };

  const canChoose = Platform.OS !== 'web' && (access === 'not_requested' || access === 'all' || access === 'limited');
  const url = card ? addMeCardUrl(card.token) : null;
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: c.textPrimary }]}>Invite a person</Text>
      <Text style={[styles.body, { color: c.textMetadata }]}>
        Share your public card link with one person. Choose the recipient and send in your share app or WhatsApp. This does not find OpenChat users or send automatically.
      </Text>

      {card && <AddMeCardView card={card.preview} />}
      <TouchableOpacity onPress={() => navigation.navigate('MyCard')} accessibilityRole="button">
        <Text style={[styles.buttonText, { color: c.primary }]}>Edit public card</Text>
      </TouchableOpacity>

      <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.heading, { color: c.textPrimary }]}>Your invitation</Text>
        <Text style={[styles.body, { color: c.textMetadata }]}>
          {selectedName ? `For ${selectedName}. Choose this person again in the share app.` : 'Choose one person in the share app.'}
        </Text>
        {url ? <Text selectable style={[styles.preview, { color: c.textPrimary }]}>{cardInviteMessage(url)}</Text>
          : error ? <Text style={[styles.body, { color: c.danger }]}>Your card link is unavailable.</Text>
            : <ActivityIndicator color={c.primary} />}
      </View>

      {canChoose && (
        <TouchableOpacity style={[styles.button, { borderColor: c.border }]} onPress={() => void choose()} disabled={busy} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: c.textPrimary }]}>
            {access === 'not_requested' ? 'Choose from Contacts' : 'Choose one contact'}
          </Text>
        </TouchableOpacity>
      )}
      {access === 'limited' && Platform.OS === 'ios' && (
        <TouchableOpacity style={[styles.button, { borderColor: c.border }]} onPress={() => void more()} disabled={busy} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: c.textPrimary }]}>Allow more contacts</Text>
        </TouchableOpacity>
      )}
      <Text style={[styles.body, { color: c.textMetadata }]}>
        {access === 'limited' ? 'Only contacts you allow are available. Contact details stay on this device.'
          : access === 'all' ? 'Contact details stay on this device.'
          : access === 'denied' ? 'Contacts access is off. You can invite someone with the share link below.'
          : Platform.OS === 'web' ? 'Browsers cannot open your address book here. Choose a recipient in your share app or copy the link.'
          : access === 'unavailable' ? 'Contacts are unavailable. You can invite someone with the share link below.'
          : 'Contacts access is optional and requested only when you tap Choose from Contacts.'}
      </Text>

      <TouchableOpacity style={[styles.button, { backgroundColor: c.primary }]} onPress={() => void handoff('share')} disabled={!url || busy} accessibilityRole="button">
        <Text style={[styles.buttonText, { color: c.onPrimary }]}>Share invitation</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.button, { borderColor: c.border }]} onPress={() => void handoff('whatsapp')} disabled={!url || busy} accessibilityRole="button">
        <Text style={[styles.buttonText, { color: c.textPrimary }]}>Open in WhatsApp</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.button, { borderColor: c.border }]} onPress={() => void handoff('copy')} disabled={!url || busy} accessibilityRole="button">
        <Text style={[styles.buttonText, { color: c.textPrimary }]}>{copied ? 'Link copied' : 'Copy link'}</Text>
      </TouchableOpacity>
      {error && <Text style={[styles.body, { color: c.danger }]}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 14, paddingBottom: 48 },
  title: { fontSize: 25, fontWeight: '700' },
  heading: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 14, lineHeight: 21 },
  panel: { borderWidth: 1, borderRadius: 16, padding: 18, gap: 10 },
  preview: { fontSize: 15, lineHeight: 23 },
  button: { borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
