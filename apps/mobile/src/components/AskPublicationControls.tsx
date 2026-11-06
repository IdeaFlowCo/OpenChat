import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import { api, type AskPublication, type AskPublicationPreview, type AskPublicationRequest, type OverlayAsk, type User } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, touchTarget, type } from '../theme/tokens';

export function AskPublicationControls({ ask }: { ask: OverlayAsk }) {
  const c = getColors(useTheme().scheme);
  const [publication, setPublication] = useState<AskPublication | null>(null);
  const [recipients, setRecipients] = useState<{ userId: string; displayName: string }[]>([]);
  const [differs, setDiffers] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ask.text);
  const [audience, setAudience] = useState<'public' | 'people'>('public');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<User[]>([]);
  const [selected, setSelected] = useState<User[]>([]);
  const [review, setReview] = useState<{ request: AskPublicationRequest; preview: AskPublicationPreview; grant: string } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!ask.fromMe) return;
    let active = true; setReady(false); setPublication(null); setError(null); setReview(null); setEditing(false);
    void api.getAskPublication(ask.id).then(result => { if (active) { setPublication(result.publication); setRecipients(result.recipients); setDiffers(result.publishedVersionDiffers); setReady(true); } }).catch(err => { if (active) { setError(err instanceof Error ? err.message : 'Publication unavailable'); setReady(false); } });
    return () => { active = false; };
  }, [ask.id, ask.revision, ask.fromMe]));
  const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity accessibilityRole="button" disabled={busy || disabled} onPress={onPress} style={{ minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space[3], borderColor: c.border, borderWidth: 1, borderRadius: radius.md, opacity: busy || disabled ? 0.5 : 1 }}><Text style={{ ...type.label, color: c.primary }}>{label}</Text></TouchableOpacity>;
  const search = async () => { setBusy(true); setError(null); try { setPeople(await api.getContacts(query, { limit: 20 })); } catch (err) { setError(err instanceof Error ? err.message : 'People unavailable'); } finally { setBusy(false); } };
  const preview = async () => {
    setBusy(true); setError(null);
    const request: AskPublicationRequest = { requestId: Crypto.randomUUID(), expectedAskRevision: ask.revision, expectedPublicationRevision: publication?.revision ?? null, text, audience: { kind: audience, targets: audience === 'people' ? selected.map(person => ({ kind: 'openchat_user', id: person.id })) : [] }, confirm: false };
    try { const result = await api.publishAsk(ask.id, request); if (!result.preview || !result.approvalGrant) throw new Error('Could not prepare the publication review'); setReview({ request, preview: result.preview, grant: result.approvalGrant }); } catch (err) { setError(err instanceof Error ? err.message : 'Could not prepare publication'); } finally { setBusy(false); }
  };
  const publish = async () => {
    if (!review) return; setBusy(true); setError(null);
    try { const result = await api.publishAsk(ask.id, { ...review.request, confirm: true, approvalGrant: review.grant }); if (!result.publication) throw new Error('Publication was not committed'); setPublication(result.publication); setRecipients(review.preview.recipients); setDiffers(false); setReview(null); setEditing(false); } catch (err) { setError(err instanceof Error ? err.message : 'Could not publish; refresh and review again'); setReview(null); } finally { setBusy(false); }
  };
  const revoke = async () => { if (!publication) return; setBusy(true); setError(null); try { setPublication((await api.revokeAskPublication(ask.id, publication.revision)).publication); setReview(null); setEditing(false); } catch (err) { setError(err instanceof Error ? err.message : 'Could not revoke'); } finally { setBusy(false); } };
  if (!ask.fromMe) return null;
  return <View style={{ borderColor: c.border, borderWidth: 1, borderRadius: radius.md, padding: space[3], gap: space[3] }}>
    <Text style={{ ...type.heading, color: c.textPrimary }}>Profile visibility</Text>
    <Text style={{ ...type.body, color: c.textMetadata }}>{!ready ? error ? 'Visibility unavailable' : 'Checking profile visibility…' : publication?.state === 'active' ? publication.audienceKind === 'public' ? 'Public · until you revoke it' : `Shared with ${recipients.map(person => person.displayName).join(', ') || 'selected people'} · until you revoke it` : publication ? 'Revoked · private ask retained' : 'Only you'}</Text>
    {publication?.state === 'active' && <Text style={{ ...type.body, color: c.textPrimary }}>Published text: {publication.text}</Text>}
    {differs && <Text style={{ ...type.body, color: c.textMetadata }}>Private version changed; published version unchanged.</Text>}
    {(busy || (!ready && !error)) && <ActivityIndicator color={c.primary} />}
    {error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text>}
    {!editing && ready && button(publication?.state === 'active' ? 'Update published version' : 'Prepare publication', () => { setEditing(true); setText(ask.text); })}
    {publication?.state === 'active' && button('Revoke publication', () => void revoke())}
    {editing && !review && <>
      <Text style={{ ...type.label, color: c.textPrimary }}>Text people will see</Text>
      <TextInput accessibilityLabel="Publication text" value={text} onChangeText={setText} multiline maxLength={1000} style={{ ...type.body, color: c.textPrimary, minHeight: touchTarget }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{button(audience === 'public' ? 'Public · selected' : 'Public', () => setAudience('public'))}{button(audience === 'people' ? 'Selected people · selected' : 'Selected people', () => setAudience('people'))}</View>
      {audience === 'people' && <>
        <TextInput accessibilityLabel="Find recipient" placeholder="Find a person by name" placeholderTextColor={c.textMetadata} value={query} onChangeText={setQuery} onSubmitEditing={() => void search()} style={{ ...type.body, color: c.textPrimary, minHeight: touchTarget }} />
        {button('Find people', () => void search())}
        {selected.map(person => <View key={person.id}>{button(`Remove ${person.name}`, () => setSelected(current => current.filter(value => value.id !== person.id)))}</View>)}
        {people.filter(person => !selected.some(value => value.id === person.id)).map(person => <View key={person.id}>{button(`Select ${person.name}`, () => setSelected(current => [...current, person]), selected.length >= 20)}</View>)}
        {people.length === 20 && <Text style={{ ...type.meta, color: c.textMetadata }}>First 20 matches. Refine the name if needed.</Text>}
      </>}
      {button('Review publication', () => void preview(), !text.trim() || (audience === 'people' && !selected.length))}
      {button('Cancel', () => setEditing(false))}
    </>}
    {review && <>
      <Text style={{ ...type.heading, color: c.textPrimary }}>Review publication</Text>
      <Text style={{ ...type.body, color: c.textPrimary }}>{review.preview.text}</Text>
      <Text style={{ ...type.body, color: c.textMetadata }}>{review.preview.audience === 'public' ? 'Everyone, including people signed out' : review.preview.recipients.map(person => person.displayName).join(', ')} · Until you revoke it</Text>
      <Text style={{ ...type.body, color: c.textMetadata }}>No messages, notifications or quiet matching. Private notes and sources stay private.</Text>
      {button('Publish', () => void publish())}{button('Cancel review', () => setReview(null))}
    </>}
  </View>;
}
