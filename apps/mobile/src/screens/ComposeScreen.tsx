import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp, RouteProps } from '../navigation/types';

/** Resolve incoming recipients, then use the same chat as every other entry point. */
export function ComposeScreen() {
  const { params } = useRoute<RouteProps<'Compose'>>();
  return <ComposeEntry key={JSON.stringify(params)} params={params} />;
}

function ComposeEntry({ params }: { params: RouteProps<'Compose'>['params'] }) {
  const navigation = useNavigation<NavProp<'Compose'>>();
  const { createConversation } = useChat();
  const c = getColors(useTheme().scheme);
  const [resolution, setResolution] = useState<'loading' | 'unclaimed' | 'unavailable' | 'error'>('loading');
  const [profileName, setProfileName] = useState('This person');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setResolution('loading');
    const open = async () => {
      if (!params.profile && !params.card) {
        navigation.replace('NewConversation');
        return;
      }
      const result = params.card
        ? { status: 'ready' as const, recipient: { id: (await api.getCardFriendStatus(params.card)).userId } }
        : await api.resolveUnlinkedRecipient(params.profile!);
      if (!active) return;
      if (result.status === 'ready') {
        // The canonical server path reuses the exact direct conversation,
        // including concurrent/repeated entries. Opening never sends a message.
        const conversation = await createConversation([result.recipient.id], { type: 'direct' });
        if (active) navigation.replace('Chat', { conversationId: conversation.id });
      } else {
        if (result.status === 'unclaimed') setProfileName(result.name);
        setResolution(result.status);
      }
    };
    void open().catch(() => { if (active) setResolution('error'); });
    // A newer profile link or Back must not be overtaken by an older request.
    return () => { active = false; };
  }, [params.profile, params.card, attempt, navigation, createConversation]);

  const button = { padding: 14, borderRadius: 12, alignItems: 'center' as const };
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 18, backgroundColor: c.background, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
    {resolution === 'loading' && <View accessibilityLiveRegion="polite" style={{ gap: 12 }}><ActivityIndicator color={c.primary} /><Text style={{ color: c.textMetadata }}>Opening conversation…</Text></View>}
    {resolution === 'unclaimed' && <>
      <Text accessibilityRole="header" style={{ color: c.textPrimary, fontSize: 28, fontWeight: '600' }}>Invite {profileName}</Text>
      <Text style={{ color: c.textPrimary, lineHeight: 24 }}>{profileName} isn’t on Unlinked yet. Share your OpenChat card so they can sign in and message you.</Text>
      <TouchableOpacity accessibilityRole="button" onPress={() => navigation.navigate('MyCard')} style={{ ...button, backgroundColor: c.primary }}><Text style={{ color: c.onPrimary }}>Get an invite link</Text></TouchableOpacity>
    </>}
    {resolution === 'unavailable' && <Text style={{ color: c.textMetadata }}>This profile is no longer available for messaging.</Text>}
    {resolution === 'error' && <>
      <Text accessibilityRole="alert" style={{ color: c.textMetadata }}>Could not open this conversation. Please try again.</Text>
      <TouchableOpacity accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={{ ...button, backgroundColor: c.surface }}><Text style={{ color: c.primary }}>Try again</Text></TouchableOpacity>
    </>}
    <TouchableOpacity accessibilityRole="button" onPress={() => navigation.goBack()} style={button}><Text style={{ color: c.primary }}>Cancel</Text></TouchableOpacity>
  </ScrollView>;
}
