import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, type User } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp, RouteProps } from '../navigation/types';

/** One inbox across Unlinked and OpenChat; messages still require an explicit Send. */
export function ComposeScreen() {
  const { params } = useRoute<RouteProps<'Compose'>>();
  return <ComposeForm key={JSON.stringify(params)} params={params} />;
}

function ComposeForm({ params }: { params: RouteProps<'Compose'>['params'] }) {
  const navigation = useNavigation<NavProp<'Compose'>>();
  const { createConversation, sendMessageToConversation } = useChat();
  const c = getColors(useTheme().scheme);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<User[]>([]);
  const [recipient, setRecipient] = useState<{ id: string; name: string } | null>(null);
  const [resolution, setResolution] = useState<'loading' | 'ready' | 'unclaimed' | 'unavailable' | 'error'>('loading');
  const [profileName, setProfileName] = useState('This person');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const conversation = useRef<{ recipientId: string; id: string } | null>(null);
  const activeIntent = useRef(true);
  const generic = !params.profile && !params.card;
  useLayoutEffect(() => {
    activeIntent.current = true;
    return () => { activeIntent.current = false; };
  }, []);
  useEffect(() => {
    if (!generic) return;
    let active = true;
    const timer = setTimeout(() => {
      api.getContacts(query || undefined, { limit: 50, offset: 0 }).then(rows => { if (active) setContacts(rows); }).catch(() => { if (active) setError('Could not load contacts. Try searching again.'); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, generic]);
  useEffect(() => {
    if (generic) { setResolution('ready'); return; }
    let active = true;
    setResolution('loading'); setError('');
    const resolve = async () => {
      if (params.card) {
        const [card, status] = await Promise.all([api.getPublicCard(params.card), api.getCardFriendStatus(params.card)]);
        return { status: 'ready' as const, recipient: { id: status.userId, name: card.name || 'OpenChat member' } };
      }
      return api.resolveUnlinkedRecipient(params.profile!);
    };
    resolve().then(result => {
      if (!active) return;
      setResolution(result.status);
      if (result.status === 'ready') setRecipient(result.recipient);
      if (result.status === 'unclaimed') setProfileName(result.name);
    }).catch(() => { if (active) { setResolution('error'); setError('We could not open this person’s inbox. Please try again.'); } });
    return () => { active = false; };
  }, [params.profile, params.card, generic, attempt]);
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
      navigation.replace('Chat', { conversationId: id });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send. Your draft is still here.'); }
    finally { pending.current = false; if (activeIntent.current) setSending(false); }
  }
  const button = { padding: 14, borderRadius: 12, alignItems: 'center' as const };
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, gap: 18, backgroundColor: c.background, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.textMetadata, fontSize: 13 }}>UNLINKED · OPENCHAT</Text>
      <Text accessibilityRole="header" style={{ color: c.textPrimary, fontSize: 28, fontWeight: '600' }}>{recipient ? `Message ${recipient.name}` : generic ? 'New message' : resolution === 'unclaimed' ? `Invite ${profileName}` : 'Message'}</Text>
      <Text style={{ color: c.textMetadata, lineHeight: 22 }}>Your Ideaflow account connects Unlinked and OpenChat.</Text>
    </View>
    {resolution === 'loading' && <View accessibilityLiveRegion="polite" style={{ gap: 12 }}><ActivityIndicator color={c.primary} /><Text style={{ color: c.textMetadata }}>Opening their inbox…</Text></View>}
    {resolution === 'unclaimed' && <>
      <Text style={{ color: c.textPrimary, lineHeight: 24 }}>{profileName} hasn’t joined yet. Share your OpenChat card so they can sign in and message you.</Text>
      <TouchableOpacity accessibilityRole="button" onPress={() => navigation.navigate('MyCard')} style={{ ...button, backgroundColor: c.primary }}><Text style={{ color: c.onPrimary }}>Get an invite link</Text></TouchableOpacity>
    </>}
    {resolution === 'unavailable' && <Text style={{ color: c.textMetadata }}>This profile is no longer available for messaging.</Text>}
    {generic && <>
      <TextInput accessibilityLabel="Search OpenChat contacts" placeholder="To: search people" placeholderTextColor={c.textMuted} value={query} onChangeText={setQuery} editable={!sending} style={{ color: c.textPrimary, borderWidth: 1, borderRadius: 12, borderColor: c.border, padding: 14 }} />
      {contacts.map(contact => <TouchableOpacity key={contact.id} accessibilityRole="button" disabled={sending} onPress={() => { conversation.current = null; setRecipient({ id: contact.id, name: contact.name || 'OpenChat member' }); }} style={{ ...button, alignItems: 'flex-start', backgroundColor: c.surface }}><Text style={{ color: c.primary }}>Choose {contact.name || 'OpenChat member'}</Text></TouchableOpacity>)}
    </>}
    {(recipient || generic) && <>
      <TextInput accessibilityLabel="Message draft" multiline value={draft} onChangeText={setDraft} editable={!sending} placeholder={recipient ? `Write to ${recipient.name}…` : 'Write a message…'} placeholderTextColor={c.textMuted} style={{ color: c.textPrimary, backgroundColor: c.surface, textAlignVertical: 'top', minHeight: 160, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 16, fontSize: 16 }} />
      <TouchableOpacity accessibilityRole="button" disabled={sending || !recipient || !draft.trim()} onPress={() => void send()} style={{ ...button, backgroundColor: c.primary, opacity: sending || !recipient || !draft.trim() ? 0.5 : 1 }}><Text style={{ color: c.onPrimary }}>{sending ? 'Sending…' : 'Send message'}</Text></TouchableOpacity>
    </>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.textMetadata }}>{error}</Text>}
    {resolution === 'error' && <TouchableOpacity accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={{ ...button, backgroundColor: c.surface }}><Text style={{ color: c.primary }}>Try again</Text></TouchableOpacity>}
    <TouchableOpacity accessibilityRole="button" disabled={sending} onPress={() => navigation.goBack()} style={button}><Text style={{ color: c.primary }}>Cancel</Text></TouchableOpacity>
  </ScrollView>;
}
