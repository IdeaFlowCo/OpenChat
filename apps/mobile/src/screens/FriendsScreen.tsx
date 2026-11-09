import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { api, type FriendLists, type FriendRow } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useSavedPeople } from '../hooks/useSavedPeople';
import { Button } from '../components/ui/Button';
import { SectionLabel } from '../components/ui/SectionLabel';
import { radius, space, touchTarget, type } from '../theme/tokens';
import { Avatar } from '../components/Avatar';
import type { NavProp, RouteProps } from '../navigation/types';

export function FriendsScreen() {
  const navigation = useNavigation<NavProp<'Friends'>>();
  const route = useRoute<RouteProps<'Friends'>>();
  const { createConversation, currentUser } = useChat();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [section, setSection] = useState<'friends' | 'requests'>(route.params?.section ?? 'friends');
  const [lists, setLists] = useState<FriendLists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const ownerId = currentUser?.userId ?? 'signed-out';
  const ownerScope = useRef({ id: ownerId, generation: 0 });
  if (ownerScope.current.id !== ownerId) ownerScope.current = { id: ownerId, generation: ownerScope.current.generation + 1 };
  const generation = ownerScope.current.generation;
  const isCurrentOwner = () => ownerScope.current.id === ownerId && ownerScope.current.generation === generation;
  const people = useSavedPeople(ownerId);
  const { refresh: refreshPeople, cancel: cancelPeople } = people;
  const [addingPerson, setAddingPerson] = useState(false);
  const [personName, setPersonName] = useState('');
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState('');
  useEffect(() => { setAddingPerson(false); setPersonName(''); setPersonBusy(false); setPersonError(''); }, [ownerId]);
  useEffect(() => () => { ownerScope.current.generation += 1; }, []);
  useFocusEffect(useCallback(() => { void refreshPeople(); return cancelPeople; }, [refreshPeople, cancelPeople]));
  const savePerson = async () => {
    if (!personName.trim() || personBusy) return; setPersonBusy(true); setPersonError('');
    try {
      const person = await api.createPrivateThing('person', personName.trim()); if (!isCurrentOwner()) return;
      people.addPerson(person); setPersonName(''); setAddingPerson(false);
      navigation.navigate('PrivateThing', { thingId: person.id });
    } catch { if (isCurrentOwner()) setPersonError('Could not save this person. Your name draft is preserved.'); }
    finally { if (isCurrentOwner()) setPersonBusy(false); }
  };

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
        <Text style={{ color: c.textPrimary, ...type.bubble, fontWeight: '600' }}>{row.user.name || 'Person'}</Text>
        <Text style={{ color: c.primary, ...type.label }}>Profile</Text>
        <Text style={{ color: c.textMetadata, ...type.label }}>{row.state === 'incoming' ? 'Wants to be friends' : row.state === 'outgoing' ? 'Request sent' : 'Friend'}</Text>
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
        <TouchableOpacity onPress={() => navigation.navigate('InvitePerson')}><Text style={{ color: c.primary, fontWeight: '700' }}>Invite a person</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('CatchUp')}><Text style={{ color: c.primary, fontWeight: '700' }}>Catch up</Text></TouchableOpacity>
      </View>
      {section === 'friends' && <View style={{ gap: space[3] }}>
        <SectionLabel first trailing={<Button label="+ Add person" variant="ghost" onPress={() => setAddingPerson(value => !value)} />}>Saved people</SectionLabel>
        <Text style={{ color: c.textMetadata, ...type.label }}>Private records, only for you. They are not linked to OpenChat accounts.</Text>
        {addingPerson && <View style={{ gap: space[2] }}><TextInput accessibilityLabel="Saved person name" value={personName} onChangeText={setPersonName} editable={!personBusy} maxLength={120} placeholder="Person's name" placeholderTextColor={c.textMuted} style={[styles.personInput, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.surface }]} /><View style={styles.tabs}><TouchableOpacity accessibilityRole="button" disabled={personBusy || !personName.trim()} onPress={() => void savePerson()} style={[styles.personButton, { backgroundColor: c.primary, opacity: personBusy || !personName.trim() ? 0.5 : 1 }]}><Text style={{ color: c.onPrimary, fontWeight: '600' }}>{personBusy ? 'Saving…' : 'Save privately'}</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" disabled={personBusy} onPress={() => setAddingPerson(false)} style={styles.personButton}><Text style={{ color: c.textPrimary }}>Cancel</Text></TouchableOpacity></View></View>}
        {!!personError && <TouchableOpacity accessibilityRole="button" style={styles.personButton} onPress={() => void refreshPeople()}><Text accessibilityRole="alert" style={{ color: c.danger }}>{personError}</Text></TouchableOpacity>}
        <Text accessibilityLiveRegion="polite" style={[type.label, { color: c.textMetadata }]}>{people.complete ? `${people.people.length} saved people` : `${people.loaded}${people.total === null ? '' : ` of ${people.total}`} loaded · ${people.loading ? 'Loading saved people…' : 'Incomplete'}`}</Text>
        {!!people.error && <><Text accessibilityRole="alert" style={{ color: c.danger }}>{people.error}</Text><Button label="Retry loading people" variant="secondary" onPress={() => void refreshPeople()} loading={people.loading} /></>}
        {!people.people.length && people.complete && <Text style={[type.label, { color: c.textMetadata }]}>No saved people yet.</Text>}
        {people.people.map(person => <TouchableOpacity key={person.id} accessibilityRole="button" accessibilityLabel={`Saved profile for ${person.name}`} onPress={() => navigation.navigate('PrivateThing', { thingId: person.id })} style={[styles.row, { borderColor: c.border }]}><View style={styles.rowContent}><Text style={{ color: c.textPrimary, ...type.bubble, fontWeight: '600' }}>{person.name}</Text><Text style={{ color: c.primary, ...type.label }}>Private profile</Text></View></TouchableOpacity>)}
      </View>}
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
  personButton: { minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space[3], borderRadius: radius.md },
  personInput: { minHeight: touchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space[3], ...type.body },
  content: { padding: space[4], gap: space[4], width: '100%', maxWidth: 960, alignSelf: 'center' },
  tabs: { flexDirection: 'row', gap: space[2] },
  tab: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingVertical: space[2], paddingHorizontal: space[4] },
  findRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[6], paddingVertical: space[2] },
  heading: { ...type.title, fontWeight: '700', marginTop: space[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingVertical: space[3], borderBottomWidth: StyleSheet.hairlineWidth },
  rowContent: { flex: 1, minWidth: 0, minHeight: touchTarget, justifyContent: 'center' },
  actions: { alignItems: 'flex-end', gap: space[2] },
});
