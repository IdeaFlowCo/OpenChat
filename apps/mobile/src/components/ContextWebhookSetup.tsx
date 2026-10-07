import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api, type AgentKey, type Conversation, type ContextWebhookSubscription } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

function routingMessage(status: ContextWebhookSubscription['routingStatus']) {
 switch (status) {
  case 'ready': return 'Ready for future eligible requests. Existing requests are not replayed.';
  case 'hosted_precedence': return 'Saved. Hosted drafts take priority; this receiver waits while your hosted agent is on.';
  case 'key_ineligible': return 'Suspended. This key is no longer eligible. Restore its read/write access and Context requests, or disable this receiver before choosing another. No other key is selected automatically.';
  case 'conversation_unavailable': return 'Suspended. You no longer have access to this conversation.';
  case 'conflict': return 'Suspended. More than one receiver is saved for this chat. Disable the extra receivers to choose one; no key is selected automatically.';
  case 'server_disabled': return 'Saved. Webhook delivery is disabled on this server.';
  case 'disabled': return 'Disabled. This receiver will not receive new requests.';
  default: return 'Saved. Refresh webhook setup to check this receiver’s status.';
 }
}
const roomLabel = (room: Conversation) => room.title || room.participants?.map(p => p.user.name).join(', ') || 'Conversation';

/** The containing review session is keyed by account; async results also stop at unmount. */
export function ContextWebhookSetup({ hostedEnabled }: { hostedEnabled?: boolean } = {}) {
 const c = getColors(useTheme().scheme);
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [available, setAvailable] = useState(false);
 const [serverAvailable, setServerAvailable] = useState<boolean>(), [statusConfirmed, setStatusConfirmed] = useState(false);
 const [keys, setKeys] = useState<AgentKey[]>([]), [allKeys, setAllKeys] = useState<AgentKey[]>([]);
 const [rooms, setRooms] = useState<Conversation[]>([]), [subscriptions, setSubscriptions] = useState<ContextWebhookSubscription[]>([]);
 const [keyId, setKeyId] = useState(''), [roomId, setRoomId] = useState(''), [url, setUrl] = useState(''), [approved, setApproved] = useState(false);
 const [secret, setSecret] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
 const requestId = useRef(''), alive = useRef(true), pending = useRef(false), lastHosted = useRef(hostedEnabled);
 useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
 const reset = () => { setApproved(false); setSecret(''); setNotice(''); requestId.current = ''; };
 const button = (label: string, onPress: () => void, disabled = busy) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, { borderColor: c.border }]}><Text style={{ color: disabled ? c.textMetadata : c.primary, fontWeight: '600' }}>{label}</Text></TouchableOpacity>;
 const load = useCallback(async () => {
  if (pending.current) return;
  pending.current = true; setOpen(true); setBusy(true); setApproved(false); setError(''); setNotice(''); setStatusConfirmed(false);
  try {
   const [state, keyResult, roomResult] = await Promise.allSettled([api.getContextWebhooks(), api.listAgentKeys(), api.getConversations()]);
   if (!alive.current) return;
   // Saved receivers remain inspectable even when a key has just lost eligibility.
   if (state.status === 'fulfilled') { setSubscriptions(state.value.subscriptions); setServerAvailable(state.value.available); setStatusConfirmed(true); }
   else if ([401, 403].includes((state.reason as { status?: number })?.status || 0)) { setSubscriptions([]); setSecret(''); }
   const ownedKeys = keyResult.status === 'fulfilled' ? keyResult.value : [];
   if (keyResult.status === 'fulfilled') setAllKeys(ownedKeys);
   if (roomResult.status === 'fulfilled') setRooms(roomResult.value);
   const active = ownedKeys.filter(k => !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > Date.now()) && k.scopes.includes('read') && k.scopes.includes('write'));
   const preferences = await Promise.allSettled(active.map(async key => ({ key, enabled: (await api.getContextAgentPreferences(key.id)).enabled })));
   if (!alive.current) return;
   setKeys(preferences.flatMap(result => result.status === 'fulfilled' && result.value.enabled ? [result.value.key] : []));
   setAvailable(state.status === 'fulfilled' && state.value.available && keyResult.status === 'fulfilled' && roomResult.status === 'fulfilled');
   const failure = [state, keyResult, roomResult].find(result => result.status === 'rejected');
   if (failure?.status === 'rejected') setError(failure.reason instanceof Error ? failure.reason.message : 'Could not refresh webhook setup. Retry before saving a receiver.');
   else if (preferences.some(result => result.status === 'rejected')) setError('Some keys could not be checked and cannot be selected. Your saved receivers are shown below. Refresh to try again.');
  } catch (e) { if (alive.current) { setAvailable(false); setKeys([]); setError(e instanceof Error ? e.message : 'Could not refresh webhook setup.'); } }
  finally { if (alive.current) { pending.current = false; setBusy(false); } }
 }, []);
 // A hosted toggle invalidates consent immediately, then refreshes authoritative routing status.
 useEffect(() => {
  if (lastHosted.current === hostedEnabled) return;
  setApproved(false);
  if (!open) lastHosted.current = hostedEnabled;
  else if (!busy) { lastHosted.current = hostedEnabled; void load(); }
 }, [hostedEnabled, open, busy, load]);
 const selectedKey = keys.find(key => key.id === keyId), selectedRoom = rooms.find(room => room.id === roomId);
 const existing = subscriptions.filter(subscription => subscription.enabled && subscription.conversationId === roomId);
 const canApprove = available && !!selectedKey && !!selectedRoom && !!url.trim() && existing.length === 0;
 async function create() {
  if (!approved || !canApprove || pending.current) return;
  pending.current = true; setBusy(true); setError(''); setNotice('');
  requestId.current ||= `webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let refresh = false;
  let failure = '';
  try {
   const result = await api.createContextWebhook({ url: url.trim(), agentKeyId: keyId, conversationId: roomId, clientRequestId: requestId.current, consent: true });
   if (!alive.current) return;
   setStatusConfirmed(true); setSecret(result.secret); setSubscriptions(previous => [...previous.filter(s => s.id !== result.subscription.id), result.subscription]); setApproved(false);
   setNotice(`${routingMessage(result.subscription.routingStatus)} Store the signing secret in your receiver.`);
  } catch (e) {
   if (!alive.current) return;
   failure = e instanceof Error ? e.message : 'Could not save receiver. Try again.';
   refresh = [403, 409].includes((e as { status?: number }).status || 0);
   if (refresh) setApproved(false);
   setError(failure);
  } finally { if (alive.current) { pending.current = false; setBusy(false); } }
  if (refresh && alive.current) { await load(); if (alive.current) setError(`${failure} Review the current receiver before trying again.`); }
 }
 async function remove(id: string) {
  if (pending.current) return;
  pending.current = true; setBusy(true); setApproved(false); setError('');
  let removed = false;
  try {
   await api.deleteContextWebhook(id);
   if (!alive.current) return;
   setSubscriptions(previous => previous.filter(s => s.id !== id)); setSecret(''); requestId.current = '';
   removed = true;
  } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not disable receiver. Try again.'); }
  finally { if (alive.current) { pending.current = false; setBusy(false); } }
  if (removed && alive.current) { await load(); if (alive.current) setNotice('Receiver disabled. Pending deliveries cancelled. Changing receivers does not replay existing requests.'); }
 }
 const savedRoomLabel = (subscription: ContextWebhookSubscription) => { const room = rooms.find(item => item.id === subscription.conversationId); return room ? roomLabel(room) : 'Conversation unavailable'; };
 const savedKeyLabel = (subscription: ContextWebhookSubscription) => allKeys.find(key => key.id === subscription.agentKeyId)?.name || `Key ${subscription.agentKeyId}`;
 return <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
  <Text style={[styles.heading, { color: c.textPrimary }]}>External agent webhooks</Text>
  <Text style={[styles.detail, { color: c.textMetadata }]}>Choose one external receiving agent per chat. Its endpoint receives a wake-up, and that same API key fetches the shared Context request.</Text>
  {!open ? button('Set up webhooks', () => void load()) : <>
   {!available && !busy && <Text style={[styles.detail, { color: c.textMetadata }]}>{serverAvailable === false ? 'Webhook delivery is disabled on this server.' : 'Webhook setup is unavailable. Refresh to check server availability and your access.'}</Text>}
   {subscriptions.filter(s => s.enabled).map(subscription => <View key={subscription.id} style={[styles.subscription, { borderColor: c.border }]}>
    <Text style={[styles.label, { color: c.textPrimary }]}>{savedKeyLabel(subscription)} · {savedRoomLabel(subscription)}</Text>
    <Text selectable style={[styles.detail, { color: c.textPrimary }]}>{subscription.url}</Text>
    <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: c.textMetadata }]}>{busy ? 'Checking receiver status…' : statusConfirmed ? routingMessage(subscription.routingStatus) : 'Receiver status could not be refreshed. Retry before relying on delivery.'}</Text>
    {button(`Disable receiver for ${savedKeyLabel(subscription)} in ${savedRoomLabel(subscription)}`, () => void remove(subscription.id))}
   </View>)}
   <Text style={[styles.detail, { color: c.textMetadata }]}>Choose a read/write key with Context requests enabled in Agent setup. Hosted drafts take priority while your hosted agent is on. A saved key that becomes ineligible is suspended; OpenChat does not choose a different key for you.</Text>
   <Text style={[styles.label, { color: c.textPrimary }]}>Receiving API key</Text>
   {keys.length ? keys.map(key => <View key={key.id}>{button(`${keyId === key.id ? 'Selected · ' : ''}${key.name}`, () => { reset(); setKeyId(key.id); })}</View>) : <Text style={{ color: c.textMetadata }}>No eligible keys. Enable Context requests for a key in Agent setup.</Text>}
   <Text style={[styles.label, { color: c.textPrimary }]}>Conversation</Text>
   {rooms.map(room => <View key={room.id}>{button(`${roomId === room.id ? 'Selected · ' : ''}${roomLabel(room)}`, () => { reset(); setRoomId(room.id); })}</View>)}
   <Text style={[styles.label, { color: c.textPrimary }]}>Public HTTPS endpoint</Text>
   <TextInput accessibilityLabel="Webhook HTTPS endpoint" autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} value={url} onChangeText={value => { reset(); setUrl(value); }} placeholder="https://your-agent.example/context" placeholderTextColor={c.textMetadata} style={[styles.input, { color: c.textPrimary, borderColor: c.border }]} />
   {!!existing.length && <Text accessibilityRole="alert" style={[styles.detail, { color: c.textMetadata }]}>This chat already has a saved receiver. Disable it above before choosing another. Saving never replaces a receiver automatically.</Text>}
   {selectedKey && selectedRoom && !!url.trim() && <Text style={[styles.detail, { color: c.textPrimary }]}>Use {selectedKey.name} as my external Context receiver in {roomLabel(selectedRoom)}, and send event IDs and request IDs to {url.trim()}.</Text>}
   <Text style={[styles.detail, { color: c.textMetadata }]}>No post text, private notes, or messages are sent in the wake-up. This does not authorize private disclosure. While hosted drafts are on, they take priority. Changing receivers does not replay existing requests.</Text>
   {button(approved ? 'Approved · Change approval' : 'Approve this receiver and endpoint', () => setApproved(!approved), busy || !canApprove)}
   {button('Save receiving agent', () => void create(), busy || !canApprove || !approved)}
   {!!secret && <View><Text style={[styles.label, { color: c.textPrimary }]}>Signing secret</Text><Text selectable style={[styles.detail, { color: c.textPrimary }]}>{secret}</Text>{button('Copy signing secret', () => { Clipboard.setString(secret); setNotice('Signing secret copied.'); })}</View>}
   {button('Refresh webhook setup', () => void load())}
  </>}
  {!!error && <Text accessibilityRole="alert" style={[styles.detail, { color: c.danger }]}>{error}</Text>}
  {!!notice && <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: c.textMetadata }]}>{notice}</Text>}
 </View>;
}
const styles = StyleSheet.create({ panel: { padding: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, marginTop: 18 }, heading: { fontSize: 15, fontWeight: '600' }, detail: { fontSize: 14, lineHeight: 22, marginTop: 8 }, label: { fontSize: 14, fontWeight: '600', marginTop: 16, marginBottom: 6 }, button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginTop: 8, alignSelf: 'flex-start' }, input: { minHeight: 44, borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14 }, subscription: { marginTop: 16, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth } });
