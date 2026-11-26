import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { api, type CommunityDetail, type CommunitySummary } from '../api/client';
import { Button, Card, Chip, ListRow, SectionLabel } from '../components/ui';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import type { NavProp, RouteProps } from '../navigation/types';

function useRoles() { const { scheme } = useTheme(); return roles(getColors(scheme)); }
function errorText(error: unknown) { return error instanceof Error ? error.message : 'Please try again.'; }

function Page({ children, scrollRef }: { children: ReactNode; scrollRef?: RefObject<ScrollView | null> }) {
  const r = useRoles();
  return <ScrollView ref={scrollRef} style={{ flex: 1, backgroundColor: r.canvas }} keyboardShouldPersistTaps="handled"
    contentContainerStyle={styles.page}><View style={styles.content}>{children}</View></ScrollView>;
}
function Field({ label, value, onChangeText, multiline = false, maxLength = 120 }: {
  label: string; value: string; onChangeText: (text: string) => void; multiline?: boolean; maxLength?: number;
}) {
  const r = useRoles();
  return <View style={styles.field}><Text style={[type.label, { color: r.text }]}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} multiline={multiline}
      maxLength={maxLength} autoCapitalize={label.includes('invite') ? 'none' : 'sentences'}
      autoCorrect={!label.includes('invite')} placeholderTextColor={r.textMeta}
      style={[styles.input, { backgroundColor: r.input, borderColor: r.line, color: r.text }, multiline && styles.multiline]} />
  </View>;
}
function Notice({ children, error = false }: { children: string; error?: boolean }) {
  const r = useRoles();
  return <Text accessibilityRole={error ? 'alert' : undefined} style={[type.body, { color: error ? r.danger : r.textMeta }]}>{children}</Text>;
}

/** Keyed children plus the render-updated scope ref protect the first frame of
 * account/target changes and prevent an old async callback from navigating. */
export function CommunitiesScreen() {
  const { currentUser, isIdentityVerified } = useChat();
  const scope = isIdentityVerified ? currentUser?.userId : undefined;
  const active = useRef(scope); active.current = scope;
  if (!scope) return <Page><Notice>Verifying your account…</Notice></Page>;
  return <CommunityList key={scope} isCurrent={() => active.current === scope} />;
}
export function CommunityScreen() {
  const { currentUser, isIdentityVerified } = useChat();
  const { params: { communityId } } = useRoute<RouteProps<'Community'>>();
  const ownerId = isIdentityVerified ? currentUser?.userId : undefined;
  const scope = ownerId ? JSON.stringify([ownerId, communityId]) : undefined;
  const active = useRef(scope); active.current = scope;
  if (!scope || !ownerId) return <Page><Notice>Verifying your account…</Notice></Page>;
  return <CommunityHome key={scope} communityId={communityId} ownerId={ownerId} isCurrent={() => active.current === scope} />;
}

function useCurrentScope(isCurrent: () => boolean) {
  const live = useRef(isCurrent); live.current = isCurrent;
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return useCallback(() => mounted.current && live.current(), []);
}

function CommunityList({ isCurrent }: { isCurrent: () => boolean }) {
  const r = useRoles(), current = useCurrentScope(isCurrent);
  const navigation = useNavigation<NavProp<'Communities'>>();
  const { communityRevision, refreshConversations } = useChat();
  const [record, setRecord] = useState<{ revision: number; items: CommunitySummary[] } | null>(null);
  const items = record?.revision === communityRevision ? record.items : null;
  const [error, setError] = useState('');
  const [form, setForm] = useState<'create' | 'join' | null>(null);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [token, setToken] = useState('');
  const [busy, setBusy] = useState(false), busyRef = useRef(false), sequence = useRef(0);
  const load = useCallback(async () => {
    const attempt = ++sequence.current;
    if (!current()) return;
    setRecord(null); setError('');
    try { const result = await api.listCommunities(); if (current() && attempt === sequence.current) setRecord({ revision: communityRevision, items: result }); }
    catch (e) { if (current() && attempt === sequence.current) setError(errorText(e)); }
  }, [current, communityRevision]);
  useFocusEffect(useCallback(() => { void load(); return () => { sequence.current++; }; }, [load, communityRevision]));
  const submit = async () => {
    if (!current() || busyRef.current || (form === 'create' ? !name.trim() : !token.trim())) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = form === 'create' ? await api.createCommunity(name.trim(), description.trim()) : await api.joinCommunity(token.trim());
      if (!current()) return;
      void refreshConversations();
      navigation.navigate('Community', { communityId: result.id });
      setForm(null); setName(''); setDescription(''); setToken('');
      void load();
    } catch (e) { if (current()) setError(errorText(e)); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };
  return <Page>
    <Text accessibilityRole="header" style={[type.heading, { color: r.text }]}>Bring related chats together</Text>
    <Notice>A home for your groups, with one announcements chat. You choose which groups to join.</Notice>
    <View style={styles.actions}>
      <Button label="Create community" variant="primary" onPress={() => setForm(form === 'create' ? null : 'create')} disabled={busy} />
      <Button label="Join with invite" onPress={() => setForm(form === 'join' ? null : 'join')} disabled={busy} />
    </View>
    {form && <Card style={styles.form}>
      <Text style={[type.title, { color: r.text }]}>{form === 'create' ? 'Create a community' : 'Join a community'}</Text>
      {form === 'create' ? <><Field label="Community name" value={name} onChangeText={setName} />
        <Field label="Description (optional)" value={description} onChangeText={setDescription} multiline maxLength={1000} />
        <Notice>Start with just you. Invite people when you’re ready.</Notice></>
        : <><Field label="Community invite code" value={token} onChangeText={setToken} maxLength={256} />
          <Notice>Joining adds you to announcements. Other members can see your name. Related groups are optional.</Notice></>}
      <View style={styles.actions}><Button label={form === 'create' ? 'Create' : 'Join community'} variant="primary" onPress={() => { void submit(); }} loading={busy} disabled={form === 'create' ? !name.trim() : !token.trim()} />
        <Button label="Cancel" variant="ghost" disabled={busy} onPress={() => setForm(null)} /></View>
    </Card>}
    {!!error && <><Notice error>{error}</Notice><Button label="Retry" onPress={() => { void load(); }} disabled={busy} /></>}
    <SectionLabel>Your communities</SectionLabel>
    {items === null && !error && <ActivityIndicator color={r.accent} accessibilityLabel="Loading communities" />}
    {items?.length === 0 && <Card><Notice>Your communities will appear here. Create one or join with an invite from an admin.</Notice></Card>}
    {items?.map(item => <Card padding="none" key={item.id}>
      <ListRow title={item.name} subtitle={`${item.memberCount} ${item.memberCount === 1 ? 'member' : 'members'} · ${item.role}`}
        onPress={() => { if (current()) navigation.navigate('Community', { communityId: item.id }); }} />
    </Card>)}
  </Page>;
}

type Confirm = { message: string; label: string; action: () => Promise<unknown>; after?: () => void };
function CommunityHome({ communityId, ownerId, isCurrent }: { communityId: string; ownerId: string; isCurrent: () => boolean }) {
  const r = useRoles(), current = useCurrentScope(isCurrent);
  const navigation = useNavigation<NavProp<'Community'>>();
  const { communityRevision, conversations, refreshConversations, setActiveConversation } = useChat();
  const [record, setRecord] = useState<{ revision: number; data: CommunityDetail } | null>(null), [error, setError] = useState('');
  const data = record?.revision === communityRevision ? record.data : null;
  const [busy, setBusy] = useState(false), busyRef = useRef(false), sequence = useRef(0);
  const [form, setForm] = useState<'edit' | 'createGroup' | 'linkGroup' | null>(null);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [groupTitle, setGroupTitle] = useState('');
  const [invite, setInvite] = useState(''), [copied, setCopied] = useState(false), [confirm, setConfirm] = useState<Confirm | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  useLayoutEffect(() => { if (confirm) scrollRef.current?.scrollTo({ y: 0, animated: true }); }, [confirm]);
  const load = useCallback(async () => {
    const attempt = ++sequence.current;
    if (!current()) return;
    setRecord(null); setError(''); setConfirm(null); setForm(null);
    try { const result = await api.getCommunity(communityId); if (current() && attempt === sequence.current) setRecord({ revision: communityRevision, data: result }); }
    catch (e) { if (current() && attempt === sequence.current) setError(errorText(e)); }
  }, [communityId, current, communityRevision]);
  useFocusEffect(useCallback(() => { void load(); return () => { sequence.current++; }; }, [load, communityRevision]));
  const run = async (action: () => Promise<unknown>, after?: () => void, reload = true) => {
    if (!current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await action();
      if (!current()) return;
      setConfirm(null);
      void refreshConversations();
      if (after) after();
      else if (reload) await load();
    } catch (e) { if (current()) setError(errorText(e)); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };
  const openChat = async (conversationId: string) => {
    if (!current()) return;
    await refreshConversations();
    if (!current()) return;
    setActiveConversation(conversationId);
    navigation.navigate('Chat', { conversationId });
  };
  if (!data) return <Page>{error ? <><Notice error>{error}</Notice><Button label="Retry" onPress={() => { void load(); }} /></> : <ActivityIndicator color={r.accent} accessibilityLabel="Loading community" />}</Page>;
  const admin = data.role === 'owner' || data.role === 'admin';
  const linked = new Set(data.groups.map(group => group.id));
  const eligible = conversations.filter(chat => chat.type === 'group' && !chat.communityKind && !chat.unlinkedGroupId && !linked.has(chat.id)
    && chat.participants?.some(person => person.user.id === ownerId && person.role === 'owner'));
  return <Page scrollRef={scrollRef}>
    <View style={styles.heading}><Text accessibilityRole="header" style={[type.heading, styles.grow, { color: r.text }]}>{data.name}</Text><Chip label={data.role} /></View>
    {!!data.description && <Text selectable style={[type.body, { color: r.textSecondary }]}>{data.description}</Text>}
    <Notice>{`${data.memberCount} ${data.memberCount === 1 ? 'member' : 'members'} · Groups are joined separately`}</Notice>
    {!!error && <Notice error>{error}</Notice>}
    {confirm && <Card style={styles.form} testID="community-confirmation"><Notice>{confirm.message}</Notice><View style={styles.actions}>
      <Button label={confirm.label} variant="primary" loading={busy} onPress={() => { void run(confirm.action, confirm.after); }} />
      <Button label="Cancel" variant="ghost" disabled={busy} onPress={() => setConfirm(null)} />
    </View></Card>}
    <Card padding="none"><ListRow title="Announcements" icon="chat" subtitle={admin ? 'Only community admins can post' : 'Read updates from community admins'} onPress={() => { void openChat(data.announcementsId); }} /></Card>
    <SectionLabel>Groups</SectionLabel>
    <Notice>Choose Join group to get access to that group’s conversation and history.</Notice>
    {data.groups.length === 0 && <Card><Notice>No groups yet. Announcements are ready above.</Notice></Card>}
    {data.groups.map(group => <Card key={group.id} padding="none"><ListRow title={group.title} subtitle={group.joined ? 'You’re a member' : 'Optional group'}
      trailing={<Button label={group.joined ? 'Open' : 'Join group'} size="sm" disabled={busy} onPress={() => {
        if (group.joined) { void openChat(group.id); return; }
        setConfirm({ message: `Join ${group.title}? You’ll become a group member and can read its history.`, label: 'Join group',
          action: () => api.joinCommunityGroup(communityId, group.id), after: () => { void openChat(group.id); } });
      }} />} />{admin && <Button label="Remove from community" variant="ghost" size="sm" disabled={busy} style={styles.rowAction} onPress={() => setConfirm({
        message: `Remove ${group.title} from this community? The chat and its existing members stay intact.`, label: 'Remove group', action: () => api.unlinkCommunityGroup(communityId, group.id),
      })} />}</Card>)}
    {admin && <View style={styles.actions}><Button label="Create group" disabled={busy} onPress={() => setForm(form === 'createGroup' ? null : 'createGroup')} />
      <Button label="Link existing group" disabled={busy} onPress={() => { setForm(form === 'linkGroup' ? null : 'linkGroup'); void refreshConversations(); }} /></View>}
    {admin && form === 'createGroup' && <Card style={styles.form}><Field label="Group name" value={groupTitle} onChangeText={setGroupTitle} />
      <Notice>Community members can see this group’s name and choose to join. Only you are added now.</Notice>
      <Button label="Create group" variant="primary" loading={busy} disabled={!groupTitle.trim()} onPress={() => { void run(() => api.createCommunityGroup(communityId, groupTitle.trim())); }} /></Card>}
    {admin && form === 'linkGroup' && <Card style={styles.form}><Notice>Only groups you own can be linked. Unlinked-managed groups keep their existing membership controls.</Notice>
      {eligible.length === 0 && <Notice>No eligible groups. Create a group or become the owner of an existing one.</Notice>}
      {eligible.map(chat => <ListRow key={chat.id} title={chat.title || 'Untitled group'} subtitle="Select to review access" onPress={() => setConfirm({
        message: `Link ${chat.title || 'this group'}? Every community member can see its name and choose to join. Joining grants access to its existing history. Nobody is added automatically.`,
        label: 'Link group and allow joining', action: () => api.linkCommunityGroup(communityId, chat.id),
      })} />)}</Card>}
    <SectionLabel>Members</SectionLabel>
    <Card padding="none">{data.members.map((member, index) => <View key={member.id}>
      <ListRow title={`${member.name || 'Member'}${member.id === ownerId ? ' (you)' : ''}`} subtitle={member.role} divider={index > 0} />
      {admin && member.role !== 'owner' && (data.role === 'owner' || member.role === 'member') && member.id !== ownerId && <View style={[styles.actions, styles.rowAction]}>
        {data.role === 'owner' && <Button size="sm" label={member.role === 'admin' ? 'Make member' : 'Make admin'} disabled={busy} onPress={() => setConfirm({
          message: `${member.role === 'admin' ? 'Remove admin access for' : 'Give admin access to'} ${member.name || 'this member'}?`, label: member.role === 'admin' ? 'Make member' : 'Make admin',
          action: () => api.setCommunityMemberRole(communityId, member.id, member.role === 'admin' ? 'member' : 'admin'),
        })} />}
        {data.role === 'owner' && <Button size="sm" label="Transfer ownership" variant="ghost" disabled={busy} onPress={() => setConfirm({
          message: `Make ${member.name || 'this member'} the community owner? You’ll become an admin and can leave afterwards. Only the new owner can transfer ownership again.`, label: 'Transfer ownership',
          action: () => api.setCommunityMemberRole(communityId, member.id, 'owner'),
        })} />}
        <Button size="sm" label="Remove member" variant="ghost" disabled={busy} onPress={() => setConfirm({
          message: `Remove ${member.name || 'this member'} from the community and announcements? Existing group memberships are kept. Outstanding community invite codes will be revoked.`, label: 'Remove member', action: () => api.removeCommunityMember(communityId, member.id),
        })} />
      </View>}
    </View>)}</Card>
    {admin && <><SectionLabel>Manage community</SectionLabel><View style={styles.actions}>
      <Button label="Edit community" disabled={busy} onPress={() => { setName(data.name); setDescription(data.description); setForm(form === 'edit' ? null : 'edit'); }} />
      <Button label="Create invite code" disabled={busy} onPress={() => { void run(async () => { const result = await api.createCommunityInvite(communityId); if (current()) { setInvite(result.token); setCopied(false); } }, undefined, false); }} />
      <Button label="Revoke invite codes" variant="ghost" disabled={busy} onPress={() => setConfirm({ message: 'Revoke all community invite codes? People who already joined stay members.', label: 'Revoke codes', action: () => api.revokeCommunityInvites(communityId) })} />
    </View>
      {!!invite && <Card style={styles.form}><Notice>Anyone with this code can join and read announcements. It expires in seven days; creating another code replaces it. An admin may revoke it. Share it only with people you want to invite.</Notice>
        <Text selectable accessibilityLabel="Community invite code" style={[type.body, { color: r.text }]}>{invite}</Text>
        <Button label={copied ? 'Copied' : 'Copy invite code'} onPress={() => { if (current()) void Clipboard.setStringAsync(invite).then(() => { if (current()) setCopied(true); }).catch(e => { if (current()) setError(errorText(e)); }); }} />
      </Card>}
      {form === 'edit' && <Card style={styles.form}><Field label="Community name" value={name} onChangeText={setName} /><Field label="Description (optional)" value={description} onChangeText={setDescription} multiline maxLength={1000} />
        <Button label="Save changes" variant="primary" loading={busy} disabled={!name.trim()} onPress={() => { void run(() => api.updateCommunity(communityId, name.trim(), description.trim())); }} /></Card>}
    </>}
    {data.role !== 'owner' ? <Button label="Leave community" variant="destructive" disabled={busy} onPress={() => setConfirm({
      message: 'Leave this community and announcements? You’ll keep your existing group memberships. Rejoining needs an invite.', label: 'Leave community',
      action: () => api.removeCommunityMember(communityId, ownerId), after: () => navigation.navigate('Communities'),
    })} /> : <Notice>To leave, transfer ownership to another member first.</Notice>}
  </Page>;
}

const styles = StyleSheet.create({
  page: { padding: space[4], paddingBottom: space[10], alignItems: 'center' },
  content: { width: '100%', maxWidth: 720, gap: space[3] },
  heading: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  grow: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  form: { gap: space[3] },
  field: { gap: space[1] },
  input: { ...type.body, minHeight: touchTarget, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space[3], paddingVertical: space[2] },
  multiline: { minHeight: touchTarget * 2, textAlignVertical: 'top' },
  rowAction: { marginHorizontal: space[4], marginBottom: space[3] },
});
