import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import { api, type BeeperCatalogueEntry, type BeeperPublicOffer, type BeeperReadConnection, type BeeperReadJob } from '../api/client';
import { authorizeBeeperRead } from '../services/beeper/readIntent';
import { acceptBeeperReadOffer, enableBeeperReadRegistry } from '../services/beeper/deviceRegistry';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { Button, Card, Chip, ListRow, SectionLabel } from '../components/ui';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import { beeperConnectionState, beeperFailure, beeperJobState, parsePublicBeeperOffer } from '../utils/beeperStatus';
import type { NavProp, RouteProps } from '../navigation/types';

const stamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'not yet reported';
function useRoles() { return roles(getColors(useTheme().scheme)); }
function Page({ children }: { children: ReactNode }) {
  const r = useRoles();
  return <ScrollView style={{ flex: 1, backgroundColor: r.canvas }} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
    <View style={styles.content}>{children}</View></ScrollView>;
}
function Note({ children, error = false }: { children: string; error?: boolean }) {
  const r = useRoles(); return <Text accessibilityRole={error ? 'alert' : undefined} style={[type.body, { color: error ? r.danger : r.textMeta }]}>{children}</Text>;
}
function useVisit(isCurrent: () => boolean) {
  const scope = useRef(isCurrent); scope.current = isCurrent;
  const visit = useRef({ active: false });
  useFocusEffect(useCallback(() => { const current = { active: true }; visit.current = current; return () => { current.active = false; }; }, []));
  useLayoutEffect(() => () => { visit.current.active = false; }, []);
  return useCallback(() => { const captured = visit.current; return () => captured.active && scope.current(); }, []);
}

export function BeeperChatsScreen() {
  const { currentUser, isIdentityVerified } = useChat();
  const owner = isIdentityVerified ? currentUser?.userId : undefined;
  const live = useRef(owner); live.current = owner;
  return owner ? <BeeperHome key={owner} ownerId={owner} isCurrent={() => live.current === owner} /> : <Page><Note>Verifying your account…</Note></Page>;
}
export function BeeperReadScreen() {
  const { currentUser, isIdentityVerified } = useChat();
  const { params } = useRoute<RouteProps<'BeeperRead'>>();
  const scope = isIdentityVerified && currentUser?.userId ? JSON.stringify([currentUser.userId, params.connectionId, params.chatKey, params.kind, params.requestRevision]) : undefined;
  const live = useRef(scope); live.current = scope;
  return scope ? <ReadSession key={scope} ownerId={currentUser!.userId} params={params} isCurrent={() => live.current === scope} /> : <Page><Note>Verifying your account…</Note></Page>;
}

function BeeperHome({ isCurrent,ownerId }: { isCurrent: () => boolean;ownerId:string }) {
  const r = useRoles(), guard = useVisit(isCurrent), navigation = useNavigation<NavProp<'BeeperChats'>>();
  const [connections, setConnections] = useState<BeeperReadConnection[] | null>(null), [selected, setSelected] = useState('');
  const [error, setError] = useState(''), [showSetup, setShowSetup] = useState(false), [offerText, setOfferText] = useState('');
  const [offer, setOffer] = useState<BeeperPublicOffer | null>(null), [busy, setBusy] = useState(false), pending = useRef(false);
  const [grantText, setGrantText] = useState(''), [grantReady, setGrantReady] = useState(false);
  const clearRegistry = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => () => { clearRegistry.current?.(); }, []);
  const importGrant = async () => {
    if (pending.current || !grantText.trim()) return;
    const valid = guard(); if (!valid()) return;
    if (Platform.OS === 'web') { setError('Use the paired native OpenChat app to approve a selected chat grant.'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      await acceptBeeperReadOffer(ownerId, grantText.trim(), scope => new Promise(resolve => {
        if (!valid()) { resolve(false); return; }
        Alert.alert('Approve selected chat', `${scope.title} · ${scope.network==='imessage'?'iMessage':'WhatsApp'} · ${scope.chatType}\nRead-only until ${stamp(new Date(scope.expiresAt).toISOString())}.\nSelected messages will be stored privately at https://chat.ideaflow.app. This does not send or share messages.`, [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Approve chat grant', onPress: () => resolve(valid()) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      }));
      if (!valid()) return;
      clearRegistry.current?.(); clearRegistry.current = enableBeeperReadRegistry(ownerId);
      setGrantReady(true); setGrantText('');
    } catch (e) { if (valid()) setError(beeperFailure(e)); }
    finally { pending.current = false; if (valid()) setBusy(false); }
  };
  const approvalRef = useRef(offer); approvalRef.current = offer;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const valid = guard(), attempt = ++sequence.current;
    try {
      const result = await api.listBeeperConnections();
      if (!valid() || attempt !== sequence.current) return;
      setConnections(result); setError('');
      setSelected(previous => result.some(item => item.id === previous) ? previous : result.find(item => item.state === 'active')?.id ?? result[0]?.id ?? '');
    } catch (e) { if (valid() && attempt === sequence.current) setError(beeperFailure(e)); }
  }, [guard]);
  useFocusEffect(useCallback(() => { void load(); return () => { sequence.current++; }; }, [load]));
  const approve = async () => {
    if (pending.current || !offer || approvalRef.current !== offer) return;
    const valid = guard(); if (!valid()) return;
    if(offer.ownerUserId!==ownerId){setError(beeperFailure(new Error('source_owner_mismatch')));return;}
    pending.current = true; setBusy(true); setError('');
    try {
      await api.approveBeeperConnection(offer);
      if (!valid()) return;
      setOffer(null); setOfferText(''); setShowSetup(false); await load();
    } catch (e) { if (valid()) setError(beeperFailure(e)); }
    finally { pending.current = false; if (valid()) setBusy(false); }
  };
  const revoke = async () => {
    if (pending.current || !selected || selectedRef.current !== selected) return;
    const valid = guard(); if (!valid()) return;
    pending.current = true; setBusy(true);
    try { await api.revokeBeeperConnection(selected); if (valid()) { setError(''); await load(); } }
    catch (e) { if (valid()) setError(beeperFailure(e)); }
    finally { pending.current = false; if (valid()) setBusy(false); }
  };
  const active = connections?.find(item => item.id === selected);
  return <Page>
    <View style={styles.heading}><Text accessibilityRole="header" style={[type.heading, { color: r.text }]}>Beeper chats</Text><Chip label="Read-only" /></View>
    <Note>Read selected chats through your Mac, then explore their Conversation, People, Asks and Memory privately in OpenChat. WhatsApp is the default. iMessage requires a separate Mac-local account approval. Replies require their own write grant in Beeper replies.</Note>
    <View style={styles.actions}><Button label="Set up Mac connection" onPress={() => setShowSetup(value => !value)} /><Button label="Reload connections" variant="ghost" onPress={() => { void load(); }} /></View>
    {!!error && <Note error>{error}</Note>}
    {showSetup && <Card style={styles.form}>
      <Text accessibilityRole="header" style={[type.title, { color: r.text }]}>Approve a public Mac offer</Text>
      <Note>First create the read-only connection and secure device grant on your own Mac. This screen does not install an adapter, start a listener, pair a device or connect a source account.</Note>
      <Note>Destination: https://chat.ideaflow.app. Source chat titles and selected messages will be stored in your private OpenChat account. Nobody in those chats is invited or notified. Paste only the public offer, never a token or private key.</Note>
      <TextInput accessibilityLabel="Public Mac offer" placeholder="Paste public offer JSON" placeholderTextColor={r.textMeta} multiline autoCapitalize="none" autoCorrect={false}
        value={offerText} maxLength={6000} onChangeText={value => { setOfferText(value); setOffer(null); }} style={[styles.input, styles.multiline, { color: r.text, borderColor: r.line, backgroundColor: r.input }]} />
      <Button label="Review Mac offer" disabled={!offerText.trim() || busy} onPress={() => {
        try { const parsed=parsePublicBeeperOffer(offerText);if(parsed.ownerUserId!==ownerId)throw new Error('source_owner_mismatch');setOffer(parsed); setError(''); } catch { setOffer(null); setError('This is not a valid public Mac offer for chat.ideaflow.app. No connection was approved.'); }
      }} />
      {offer && <><Note>{`Approve read-only access for account ${offer.accountKey.slice(0, 12)}… on Mac ${offer.machineKey.slice(0, 12)}… until ${stamp(offer.expiresAt)}?`}</Note>
        <Button label="Approve read-only connection" variant="primary" loading={busy} onPress={() => { void approve(); }} /></>}
      <SectionLabel>Selected chat approval</SectionLabel>
      <Note>After approving a chat locally on your Mac, paste its encrypted grant here. Only your paired native device can open it. Each source read still asks for authorization.</Note>
      <TextInput accessibilityLabel="Encrypted selected chat grant" placeholder="Paste encrypted grant" placeholderTextColor={r.textMeta} multiline autoCapitalize="none" autoCorrect={false}
        value={grantText} maxLength={12000} onChangeText={setGrantText} style={[styles.input, styles.multiline, { color: r.text, borderColor: r.line, backgroundColor: r.input }]} />
      <Button label="Review selected chat grant" disabled={!grantText.trim() || busy} loading={busy} onPress={() => { void importGrant(); }} />
      {grantReady && <Note>Chat grant approved on this device. Select the same chat below, then authorize its read.</Note>}
    </Card>}
    <Button label="Beeper replies" variant="ghost" onPress={() => navigation.navigate('BeeperReplies')} />
    <SectionLabel>Connections</SectionLabel>
    {!connections && !error && <ActivityIndicator color={r.accent} accessibilityLabel="Loading Beeper connections" />}
    {connections?.length === 0 && <Card><Note>No Mac connection approved. Secure device authorization is required before a source chat can be read.</Note></Card>}
    {connections?.map(connection => <Card key={connection.id} padding="none"><ListRow title={`Mac · ${connection.machineKey.slice(0, 12)}…`} subtitle={`${beeperConnectionState(connection)} · account ${connection.accountKey.slice(0, 12)}…`}
      trailing={<Chip label={selected === connection.id ? 'Selected' : 'Select'} selected={selected === connection.id} />} onPress={() => setSelected(connection.id)} /></Card>)}
    {active && <><Note>{`Last Mac contact: ${stamp(active.heartbeatAt)}. Connection expires: ${stamp(active.expiresAt)}.`}</Note>
      {active.lastError && <Note error>{beeperFailure(new Error(active.lastError))}</Note>}
      {active.state !== 'revoked' && <Button label="Revoke read-only connection" variant="destructive" loading={busy} onPress={() => { void revoke(); }} accessibilityHint="Stops future source reads; saved copies remain private to your account." />}
      <Catalogue key={active.id} connection={active} guard={guard} open={chatKey => navigation.navigate('BeeperRead', { connectionId: active.id, chatKey, kind: 'open', requestRevision: Crypto.randomUUID() })} />
    </>}
  </Page>;
}

function Catalogue({ connection, guard, open }: { connection: BeeperReadConnection; guard: () => () => boolean; open: (chatKey: string) => void }) {
  const r = useRoles();
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<{ search: string; items: BeeperCatalogueEntry[]; cursor?: string | null } | null>(null);
  const search = query.trim(), currentSearch = useRef(search); currentSearch.current = search;
  const entries = record?.search === search ? record.items : null;
  const cursor = record?.search === search ? record.cursor : null;
  const sequence = useRef(0), mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (after?: string) => {
    const valid = guard(), attempt = ++sequence.current;
    setLoading(true);
    try {
      const result = await api.getBeeperCatalogue(connection.id, { search, cursor: after });
      if (mounted.current && valid() && attempt === sequence.current && currentSearch.current === search) {
        setRecord(previous => ({ search, cursor: result.nextCursor,
          items: after && previous?.search === search ? [...new Map([...previous.items, ...result.items].map(item => [item.chatKey, item])).values()] : result.items }));
        setError('');
      }
    } catch (e) { if (mounted.current && valid() && attempt === sequence.current && currentSearch.current === search) setError(beeperFailure(e)); }
    finally { if (mounted.current && valid() && attempt === sequence.current) setLoading(false); }
  }, [connection.id, guard, search]);
  useFocusEffect(useCallback(() => { const timer = setTimeout(() => { void load(); }, search ? 250 : 0); return () => { clearTimeout(timer); sequence.current++; }; }, [load, search]));
  return <><SectionLabel>Source chats</SectionLabel><Note>The catalogue may be partial. Reload catalogue reads the last report from your Mac; it does not refresh chat messages.</Note>
    <TextInput accessibilityLabel="Search Beeper chats" placeholder="Search source chats" placeholderTextColor={r.textMeta} value={query} maxLength={100} onChangeText={setQuery} style={[styles.input, { color: r.text, backgroundColor: r.input, borderColor: r.line }]} />
    <Button label="Reload catalogue" variant="ghost" loading={loading} onPress={() => { void load(); }} />
    {!!error && <Note error>{error}</Note>}
    {!entries && !error && <ActivityIndicator color={r.accent} accessibilityLabel="Loading source catalogue" />}
    {entries?.length === 0 && <Note>{search ? 'No matching chats in the reported catalogue.' : 'Waiting for your Mac to report its catalogue. Approving this connection does not start the Mac adapter.'}</Note>}
    {entries?.map(entry => <Card key={entry.chatKey} padding="none"><ListRow title={entry.title}
      subtitle={`${entry.network==='imessage'?'iMessage':'WhatsApp'} · ${entry.chatType === 'group' ? 'Group' : 'Direct chat'} · Catalogue read ${stamp(entry.sourceReadAt)}${entry.importedChatId ? ' · saved copy available' : ''}`}
      onPress={() => { if (mounted.current && guard()()) open(entry.chatKey); }} /></Card>)}
    {!!cursor && <><Note>{`${entries?.length ?? 0} reported chats loaded. More are available.`}</Note><Button label="Load more source chats" loading={loading} onPress={() => { void load(cursor); }} /></>}
  </>;
}

function ReadSession({ params, isCurrent,ownerId }: { ownerId:string;params: RouteProps<'BeeperRead'>['params']; isCurrent: () => boolean }) {
  const r = useRoles(), guard = useVisit(isCurrent), navigation = useNavigation<NavProp<'BeeperRead'>>();
  const [source, setSource] = useState<{ connection: BeeperReadConnection; chat: BeeperCatalogueEntry } | null>(null);
  const [job, setJob] = useState<BeeperReadJob | null>(null), [error, setError] = useState('');
  const [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(false), pending = useRef(false);
  const requestId = useRef<string | null>(null), jobRef = useRef<BeeperReadJob | null>(null);
  const [polling, setPolling] = useState(false);
  const prepare = useCallback(async () => {
    const valid = guard(); if (!valid() || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const connections = await api.listBeeperConnections(); if (!valid()) return;
      const connection = connections.find(item => item.id === params.connectionId);
      if (!connection) throw new Error('connection_not_available');
      const catalogue = await api.getBeeperCatalogue(connection.id, { chatKey: params.chatKey }); if (!valid()) return;
      const chat = catalogue.items.find(item => item.chatKey === params.chatKey);
      if (!chat) throw new Error('chat_not_available');
      setSource({ connection, chat });
      requestId.current ??= `beeper-read:${Crypto.randomUUID()}`;
      const reserved = jobRef.current ?? await api.requestBeeperRead(connection.id, { chatKey: chat.chatKey, clientRequestId: requestId.current, kind: params.kind });
      if (!valid()) return;
      if(reserved.kind!==params.kind)throw new Error('source_request_mismatch');
      const next = await api.getBeeperReadJob(connection.id, reserved.id);
      if (!valid()) return;
      if(next.id!==reserved.id||next.kind!==params.kind)throw new Error('source_request_mismatch');
      jobRef.current = next; setJob(next);
      // A leased job already has a device-authorized intent. Pending jobs need
      // the explicit authorization button; reservation itself grants no read.
      if (next.state === 'leased') { setAuthorized(true); setPolling(true); }
    } catch (e) { if (valid()) setError(beeperFailure(e)); }
    finally { pending.current = false; if (valid()) setBusy(false); }
  }, [guard, params.connectionId, params.chatKey, params.kind]);
  useFocusEffect(useCallback(() => { void prepare(); }, [prepare]));
  const authorize = async () => {
    const valid = guard(); if (!valid() || !source || !job || pending.current) return;
    if(job.kind!==params.kind||jobRef.current?.id!==job.id){setError(beeperFailure(new Error('source_request_mismatch')));return;}
    pending.current = true; setBusy(true); setError('');
    try {
      const frame = await authorizeBeeperRead(source.connection, job, source.chat,ownerId); if (!valid()) return;
      await api.attachBeeperReadIntent(source.connection.id, job.id, frame); if (!valid()) return;
      setAuthorized(true); setPolling(true);
    } catch (e) { if (valid()) setError(beeperFailure(e)); }
    finally { pending.current = false; if (valid()) setBusy(false); }
  };
  const checkProgress = async () => {
    const valid = guard(); if (!valid() || !job || pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const next = await api.getBeeperReadJob(params.connectionId, job.id);
      if (!valid()) return;
      if(next.id!==job.id||next.kind!==params.kind)throw new Error('source_request_mismatch');
      jobRef.current = next; setJob(next); setError('');
      if (next.state === 'leased') { setAuthorized(true); setPolling(true); }
    } catch (e) { if (valid()) setError(beeperFailure(e)); }
    finally { pending.current = false; if (valid()) setBusy(false); }
  };
  useFocusEffect(useCallback(() => {
    if (!polling || !jobRef.current) return;
    const valid = guard(); let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const requested=jobRef.current!.id;
        const next = await api.getBeeperReadJob(params.connectionId, requested);
        if (stopped || !valid()) return;
        if(next.id!==requested||next.kind!==params.kind)throw new Error('source_request_mismatch');
        jobRef.current = next; setJob(next); setError('');
        if (['done', 'failed', 'cancelled'].includes(next.state)) { setPolling(false); return; }
      } catch (e) { if (!stopped && valid()) setError(beeperFailure(e)); }
      if (!stopped && valid()) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [guard, params.connectionId, params.kind, polling]));
  const chatId = job?.chatId ?? source?.chat.importedChatId;
  const openSaved = () => {
    if (!guard()() || !chatId || !source) return;
    navigation.navigate('ImportedChat', { chatId, title: source.chat.title, beeper: { connectionId: params.connectionId, chatKey: params.chatKey, jobId: job?.id } });
  };
  return <Page><View style={styles.heading}><Text accessibilityRole="header" style={[type.heading, styles.grow, { color: r.text }]}>{source?.chat.title ?? 'Read from Beeper'}</Text><Chip label="Read-only" /></View>
    <Note>Only this selected chat is requested. A typed authorization on your paired device is required; no message is sent and no source app is controlled.</Note>
    <Card style={styles.form}><Text accessibilityLiveRegion="polite" style={[type.title, { color: r.text }]}>{beeperJobState(job, authorized)}</Text>
      {busy && <ActivityIndicator color={r.accent} accessibilityLabel="Preparing or authorizing read" />}
      {source && <Note>{beeperConnectionState(source.connection)}</Note>}
      {!!error && <Note error>{error}</Note>}
      {job?.completedAt && <Note>{`Server-confirmed completion: ${stamp(job.completedAt)}. Coverage can still be partial; this is a snapshot, not a live conversation.`}</Note>}
      {job?.lastBatchAt && !job.completedAt && <Note>{`Last partial batch received: ${stamp(job.lastBatchAt)}. The source refresh is not complete.`}</Note>}
      {job?.lastError && <Note error>{beeperFailure(new Error(job.lastError))}</Note>}
      {job?.state === 'pending' && !authorized && <Button label="Authorize selected chat read" variant="primary" loading={busy} onPress={() => { void authorize(); }} />}
      {job && <Button label="Check read progress" variant="ghost" disabled={busy} onPress={() => { void checkProgress(); }} />}
      {!job && !busy && <Button label="Retry source request" onPress={() => { void prepare(); }} />}
      {job?.state === 'done' && !job.completedAt && <Note>Waiting for a server completion receipt. This copy has not been marked refreshed.</Note>}
      {chatId && <><Note>{job?.state === 'done' && job.completedAt ? 'Open the saved result below.' : 'A saved copy is available, but may be partial or stale. Opening it does not complete this refresh.'}</Note>
        <Button label="Open saved copy" onPress={openSaved} /></>}
    </Card>
    <Button label="Back to Beeper chats" variant="ghost" onPress={() => { if (guard()()) navigation.navigate('BeeperChats'); }} />
  </Page>;
}

const styles = StyleSheet.create({
  page: { padding: space[4], paddingBottom: space[10], alignItems: 'center' },
  content: { width: '100%', maxWidth: 720, gap: space[3] },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  grow: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  form: { gap: space[3] },
  input: { ...type.body, minHeight: touchTarget, paddingHorizontal: space[3], paddingVertical: space[2], borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  multiline: { minHeight: touchTarget * 3, textAlignVertical: 'top' },
});
