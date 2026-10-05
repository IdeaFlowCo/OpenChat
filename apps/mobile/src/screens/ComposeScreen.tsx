import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, type User } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp, RouteProps } from '../navigation/types';

/** Nothing is sent or linked until the sender chooses a recipient and presses Send. */
export function ComposeScreen() {
  const { params } = useRoute<RouteProps<'Compose'>>();
  return <ComposeForm key={JSON.stringify(params)} params={params} />;
}

function ComposeForm({ params }: { params: RouteProps<'Compose'>['params'] }) {
  const navigation = useNavigation<NavProp<'Compose'>>();
  const { createConversation, sendMessageToConversation } = useChat();
  const c = getColors(useTheme().scheme);
  const [draft, setDraft] = useState(params.profile ? `About this Unlinked profile: ${params.profile}` : '');
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<User[]>([]);
  const [recipient, setRecipient] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const manuallyChosen = useRef(false);
  const conversation = useRef<{ recipientId: string; id: string } | null>(null);
  const activeIntent = useRef(true);
  useLayoutEffect(() => {
    activeIntent.current = true;
    return () => { activeIntent.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api.getContacts(query || undefined, { limit: 50, offset: 0 }).then(rows => { if (active) setContacts(rows); }).catch(() => { if (active) setError('Could not load contacts. Try searching again.'); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  useEffect(() => {
    if (!params.card) return;
    let active = true;
    // The card service, rather than a profile name/email, proves the recipient.
    Promise.all([api.getPublicCard(params.card), api.getCardFriendStatus(params.card)]).then(([card, status]) => {
      if (active && !manuallyChosen.current) setRecipient({ id: status.userId, name: card.name || 'OpenChat member' });
    }).catch(() => { if (active) setError('This OpenChat card is unavailable. Choose an OpenChat contact.'); });
    return () => { active = false; };
  }, [params.card]);
  async function send() {
    if (pending.current || !recipient || !draft.trim()) return;
    pending.current = true; setSending(true); setError('');
    try {
      const recipientId = recipient.id;
      let id = conversation.current?.recipientId === recipientId ? conversation.current.id : undefined;
      if (!id) id = (await createConversation([recipientId], { type: 'direct' })).id;
      if (!activeIntent.current) return;
      conversation.current = { recipientId, id };
      await sendMessageToConversation(id, draft);
      if (!activeIntent.current) return;
      if (activeIntent.current) navigation.replace('Chat', { conversationId: id });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send. Your draft is still here.'); }
    finally { pending.current = false; setSending(false); }
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 12, backgroundColor: c.background }}>
    <Text style={{ color: c.textPrimary, fontSize: 22 }}>Message with OpenChat</Text>
    <Text style={{ color: c.textMetadata }}>The Unlinked profile is context, not a verified OpenChat recipient. Choose who receives your message. Nothing is sent automatically.</Text>
    {recipient ? <Text style={{ color: c.textPrimary }}>To: {recipient.name}</Text> : <Text style={{ color: c.textMetadata }}>No recipient selected</Text>}
    <TextInput accessibilityLabel="Search OpenChat contacts" placeholder="Search OpenChat contacts" placeholderTextColor={c.textMuted} value={query} onChangeText={setQuery} editable={!sending} style={{ color: c.textPrimary, borderWidth: 1, borderColor: c.border, padding: 12 }} />
    {contacts.map(contact => <TouchableOpacity key={contact.id} accessibilityRole="button" disabled={sending} onPress={() => { manuallyChosen.current = true; conversation.current = null; setRecipient({ id: contact.id, name: contact.name || 'OpenChat member' }); }} style={{ padding: 12, backgroundColor: c.surface }}><Text style={{ color: c.primary }}>Choose {contact.name || 'OpenChat member'}</Text></TouchableOpacity>)}
    <TextInput accessibilityLabel="Message draft" multiline value={draft} onChangeText={setDraft} editable={!sending} placeholder="Write a message" placeholderTextColor={c.textMuted} style={{ color: c.textPrimary, minHeight: 120, borderWidth: 1, borderColor: c.border, padding: 12 }} />
    {!!error && <Text accessibilityRole="alert" style={{ color: c.textMetadata }}>{error}</Text>}
    <TouchableOpacity accessibilityRole="button" disabled={sending || !recipient || !draft.trim()} onPress={() => void send()} style={{ padding: 14, backgroundColor: c.primary, opacity: sending || !recipient || !draft.trim() ? 0.5 : 1 }}><Text style={{ color: c.onPrimary }}>Send message</Text></TouchableOpacity>
    {sending && <ActivityIndicator color={c.primary} />}
    <TouchableOpacity accessibilityRole="button" disabled={sending} onPress={() => navigation.goBack()}><Text style={{ color: c.primary }}>Cancel</Text></TouchableOpacity>
  </ScrollView>;
}
