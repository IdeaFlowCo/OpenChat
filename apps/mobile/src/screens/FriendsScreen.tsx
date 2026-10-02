import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { api, type FriendLists, type FriendRow } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import type { NavProp, RouteProps } from '../navigation/types';

export function FriendsScreen() {
  const navigation = useNavigation<NavProp<'Friends'>>();
  const route = useRoute<RouteProps<'Friends'>>();
  const { createConversation } = useChat();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [section, setSection] = useState<'friends' | 'requests'>(route.params?.section ?? 'friends');
  const [lists, setLists] = useState<FriendLists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setLists(await api.listFriends()); setError(null); }
    catch { setError('Could not load friends. Try again.'); }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const act = async (userId: string, action: 'accept' | 'decline' | 'cancel' | 'remove') => {
    setBusyId(userId);
    try { await api.changeFriend(userId, action); await refresh(); }
    catch { setError('Could not update request. Try again.'); }
    finally { setBusyId(null); }
  };
  const message = async (userId: string) => {
    setBusyId(userId);
    try {
      const conversation = await createConversation([userId], { type: 'direct' });
      navigation.navigate('Chat', { conversationId: conversation.id });
    } catch { setError('Could not open message. Try again.'); }
    finally { setBusyId(null); }
  };
  const block = async (userId: string) => {
    setBusyId(userId);
    try { await api.blockUser(userId); await refresh(); }
    catch { setError('Could not block this person. Try again.'); }
    finally { setBusyId(null); }
  };

  const renderRow = (row: FriendRow) => (
    <View key={row.userId} style={[styles.row, { borderColor: c.border }]}>
      <Avatar name={row.user.name || 'Person'} avatarUrl={row.user.avatarUrl ?? undefined} size={42} />
      <TouchableOpacity style={styles.rowContent} accessibilityRole="button" accessibilityLabel={`Profile for ${row.user.name || 'person'}`} onPress={() => navigation.navigate('ContactProfile', { userId: row.userId })}>
        <Text style={{ color: c.textPrimary, fontSize: 16, fontWeight: '600' }}>{row.user.name || 'Person'}</Text>
        <Text style={{ color: c.primary, fontSize: 13 }}>Profile</Text>
        <Text style={{ color: c.textMetadata, fontSize: 13 }}>{row.state === 'incoming' ? 'Wants to be friends' : row.state === 'outgoing' ? 'Request sent' : 'Friend'}</Text>
      </TouchableOpacity>
      {busyId === row.userId ? <ActivityIndicator color={c.primary} /> : (
        <View style={styles.actions}>
          {row.state === 'incoming' && <><TouchableOpacity onPress={() => void act(row.userId, 'accept')}><Text style={{ color: c.primary, fontWeight: '700' }}>Accept</Text></TouchableOpacity><TouchableOpacity onPress={() => void act(row.userId, 'decline')}><Text style={{ color: c.textSecondary }}>Decline</Text></TouchableOpacity><TouchableOpacity onPress={() => void block(row.userId)}><Text style={{ color: c.danger }}>Block</Text></TouchableOpacity></>}
          {row.state === 'outgoing' && <TouchableOpacity onPress={() => void act(row.userId, 'cancel')}><Text style={{ color: c.textSecondary }}>Cancel</Text></TouchableOpacity>}
          {row.state === 'friends' && <><TouchableOpacity onPress={() => void message(row.userId)}><Text style={{ color: c.primary, fontWeight: '700' }}>Message</Text></TouchableOpacity><TouchableOpacity onPress={() => void act(row.userId, 'remove')}><Text style={{ color: c.textSecondary }}>Remove</Text></TouchableOpacity></>}
        </View>
      )}
    </View>
  );

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={styles.tabs}>
        {(['friends', 'requests'] as const).map(tab => <TouchableOpacity key={tab} onPress={() => setSection(tab)} style={[styles.tab, { borderColor: c.border, backgroundColor: section === tab ? c.primary : c.surface }]}><Text style={{ color: section === tab ? c.onPrimary : c.textPrimary, fontWeight: '700' }}>{tab === 'friends' ? 'Friends' : `Requests${lists?.incoming.length ? ` (${lists.incoming.length})` : ''}`}</Text></TouchableOpacity>)}
      </View>
      <View style={styles.findRow}>
        <TouchableOpacity onPress={() => navigation.navigate('NewConversation')}><Text style={{ color: c.primary, fontWeight: '700' }}>Find people</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('ScanQr')}><Text style={{ color: c.primary, fontWeight: '700' }}>Scan a code</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('CatchUp')}><Text style={{ color: c.primary, fontWeight: '700' }}>Catch up</Text></TouchableOpacity>
      </View>
      {error && <TouchableOpacity onPress={() => void refresh()}><Text style={{ color: c.danger }}>{error}</Text></TouchableOpacity>}
      {!lists && !error && <ActivityIndicator color={c.primary} />}
      {lists && section === 'friends' && (lists.friends.length ? lists.friends.map(renderRow) : <Text style={{ color: c.textMetadata }}>No friends yet. Scan a code or find someone to send a request.</Text>)}
      {lists && section === 'requests' && <>
        <Text style={[styles.heading, { color: c.textPrimary }]}>Received</Text>
        {lists.incoming.length ? lists.incoming.map(renderRow) : <Text style={{ color: c.textMetadata }}>No new requests.</Text>}
        <Text style={[styles.heading, { color: c.textPrimary }]}>Sent</Text>
        {lists.outgoing.length ? lists.outgoing.map(renderRow) : <Text style={{ color: c.textMetadata }}>No pending requests.</Text>}
      </>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 18 },
  findRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 24, paddingVertical: 8 },
  heading: { fontSize: 17, fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowContent: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  actions: { alignItems: 'flex-end', gap: 8 },
});
