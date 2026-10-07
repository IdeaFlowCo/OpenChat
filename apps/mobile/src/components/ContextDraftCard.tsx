import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { HostedContextRequest } from '../types/contextHosted';

export type DraftAction = 'publish' | 'revise' | 'decline' | 'cancel' | 'reload';
export type DraftActionInput = { text?: string; privateText?: string };
const labels: Record<HostedContextRequest['status'], string> = {
  queued: 'Queued privately', processing: 'Preparing a private draft', review: 'Ready for your review',
  published: 'Published to Context', declined: 'Declined', cancelled: 'Cancelled', failed: 'Could not prepare a draft',
  expired: 'Request expired', unavailable: 'Review needs updating',
};
const pendingStatuses = ['queued', 'processing', 'review'];

export function ContextDraftCard({ request, enabled, busy, error, blocked, onAction, onEditingChange }: {
  request: HostedContextRequest;
  enabled: boolean;
  busy: boolean;
  error?: string;
  blocked: boolean;
  onAction: (action: DraftAction, input?: DraftActionInput) => Promise<boolean>;
  onEditingChange: (editing: boolean) => void;
}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(request.draft?.text ?? '');
  const [addingPrivate, setAddingPrivate] = useState(false);
  const [privateText, setPrivateText] = useState('');
  const submitting = useRef(false);
  const [draftId, setDraftId] = useState(request.draft?.id);
  useEffect(() => {
    if (draftId !== request.draft?.id) {
      setDraftId(request.draft?.id);
      setText(request.draft?.text ?? ''); setEditing(false); setAddingPrivate(false); setPrivateText('');
      onEditingChange(false);
    }
  }, [draftId, request.draft?.id, request.draft?.text, onEditingChange]);
  const canRetainInput = enabled && pendingStatuses.includes(request.status);
  useEffect(() => {
    if (!canRetainInput && (editing || addingPrivate || privateText)) {
      setEditing(false); setAddingPrivate(false); setPrivateText(''); setText(''); onEditingChange(false);
    }
  }, [canRetainInput, editing, addingPrivate, privateText, onEditingChange]);
  const expired = Date.parse(request.expiresAt) <= Date.now();
  const locked = busy || !enabled || expired || draftId !== request.draft?.id;
  const active = pendingStatuses.includes(request.status);
  const hasDraft = request.status === 'review' && !!request.draft;
  const perform = async (action: DraftAction, input?: DraftActionInput) => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      if (await onAction(action, input)) {
        setEditing(false); setAddingPrivate(false); setPrivateText(''); onEditingChange(false);
      }
    } finally { submitting.current = false; }
  };
  const button = (label: string, press: () => void, options: { primary?: boolean; disabled?: boolean } = {}) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!options.disabled }}
      disabled={options.disabled} onPress={press} style={[styles.button, { backgroundColor: options.primary ? c.primary : c.surface, borderColor: c.border, opacity: options.disabled ? 0.5 : 1 }]}>
      <Text style={{ color: options.primary ? c.onPrimary : c.primary, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
  return <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
    <Text style={[styles.status, { color: c.textMetadata }]}>{labels[request.status]}</Text>
    <Text style={[styles.title, { color: c.textPrimary }]}>{request.conversationTitle || 'Conversation'}</Text>
    <Text style={[styles.detail, { color: c.textMetadata }]}>Destination · Context in this conversation</Text>
    <Text style={[styles.detail, { color: c.textMetadata }]}>Current audience ({request.audience.length}) · {request.audience.map(person => person.name || 'Chat participant').join(', ') || 'Audience unavailable'}</Text>
    <View style={[styles.section, { borderColor: c.border }]}>
      <Text style={[styles.label, { color: c.textPrimary }]}>Replying to {request.source.author.name || 'a participant'}</Text>
      <Text selectable style={[styles.body, { color: c.textPrimary }]}>{request.source.text}</Text>
      <Text style={[styles.detail, { color: c.textMetadata }]}>Shared Context · revision {request.sourceRevision}</Text>
    </View>
    {request.privateInputIncluded && <View style={[styles.section, { borderColor: c.border }]}>
      <Text style={[styles.label, { color: c.textPrimary }]}>Private source · visible only in your review</Text>
      <Text selectable style={[styles.body, { color: c.textPrimary }]}>{request.privateText || request.privateInputSummary || 'Private text supplied for this request'}</Text>
      <Text style={[styles.detail, { color: c.textMetadata }]}>Anthropic processes this text for your private draft. It is not shared with the conversation unless included in the reply you publish.</Text>
      {active && !editing && !addingPrivate && button('Regenerate without private text', () => void perform('revise', { privateText: '' }), { disabled: locked || blocked })}
    </View>}
    {hasDraft && <View style={[styles.section, { borderColor: c.border }]}>
      <Text style={[styles.label, { color: c.textPrimary }]}>{editing ? 'Edit proposed reply' : 'Exact reply to publish'}</Text>
      {editing ? <>
        <TextInput accessibilityLabel="Edit proposed Context reply" value={text} onChangeText={setText} editable={!busy} multiline maxLength={20000}
          style={[styles.input, { color: c.textPrimary, backgroundColor: c.background, borderColor: c.border }]} />
        <Text style={[styles.detail, { color: c.textMetadata }]}>Edits require a new review. Save first; nothing is published yet.</Text>
        <View style={styles.actions}>
          {button('Save for review', () => void perform('revise', { text }), { primary: true, disabled: locked || !text.trim() || blocked })}
          {button('Cancel edit', () => { setText(request.draft!.text); setEditing(false); onEditingChange(false); }, { disabled: busy })}
        </View>
      </> : <Text selectable style={[styles.body, { color: c.textPrimary }]}>{request.draft!.text}</Text>}
    </View>}
    {request.error && <Text style={[styles.detail, { color: c.danger }]}>{request.error}</Text>}
    {error && <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={[styles.detail, { color: c.danger }]}>{error}</Text>}
    {blocked && <Text style={[styles.detail, { color: c.textMetadata }]}>The source, audience, or permission may have changed. Reload and review before publishing.</Text>}
    {['unavailable', 'cancelled', 'expired'].includes(request.status) && <Text style={[styles.detail, { color: c.textMetadata }]}>Use Ask agents again on the current post in Context to start a new request.</Text>}
    {active && expired && <Text style={[styles.detail, { color: c.textMetadata }]}>This request has expired. Reload and use Ask agents again on the current Context post.</Text>}
    {active && <Text style={[styles.detail, { color: c.textMetadata }]}>Private until you publish · expires {new Date(request.expiresAt).toLocaleString()}</Text>}
    {hasDraft && !editing && !addingPrivate && <>
      <Text style={[styles.detail, { color: c.textMetadata }]}>Publish stores the exact reply in this conversation’s Context. Current and future authorized members and their agents can read it. No chat message or notification is sent.</Text>
      <View style={styles.actions}>
        {button('Publish to Context', () => void perform('publish'), { primary: true, disabled: locked || blocked || !request.audience.length })}
        {button('Edit reply', () => { setText(request.draft!.text); setEditing(true); onEditingChange(true); }, { disabled: locked || blocked })}
        {button('Decline draft', () => void perform('decline'), { disabled: busy })}
      </View>
    </>}
    {addingPrivate && canRetainInput && <View style={[styles.section, { borderColor: c.border }]}>
      <Text style={[styles.label, { color: c.textPrimary }]}>Private context for this request</Text>
      <Text style={[styles.detail, { color: c.textMetadata }]}>This text will be sent to Anthropic to prepare a private draft. Other participants receive nothing until you review and publish the exact reply.</Text>
      <TextInput accessibilityLabel="Private context for this request" value={privateText} onChangeText={setPrivateText} editable={!busy} multiline maxLength={8000}
        style={[styles.input, { color: c.textPrimary, backgroundColor: c.background, borderColor: c.border }]} />
      <View style={styles.actions}>
        {button('Prepare private draft', () => void perform('revise', { privateText }), { primary: true, disabled: locked || blocked || !privateText.trim() })}
        {button('Cancel private input', () => { setAddingPrivate(false); setPrivateText(''); onEditingChange(false); }, { disabled: busy })}
      </View>
    </View>}
    <View style={styles.actions}>
      {(blocked || ['failed', 'unavailable', 'expired'].includes(request.status)) && button('Reload review', () => void perform('reload'), { disabled: busy })}
      {request.status === 'failed' && !blocked && button('Retry private draft', () => void perform('revise', { privateText: request.privateText || '' }), { disabled: locked })}
      {active && !editing && !addingPrivate && button('Add private context', () => { setAddingPrivate(true); onEditingChange(true); }, { disabled: locked || blocked })}
      {['queued', 'processing'].includes(request.status) && button('Cancel request', () => void perform('cancel'), { disabled: busy })}
    </View>
    {busy && <ActivityIndicator accessibilityLabel="Updating private draft" color={c.primary} style={{ marginTop: 12 }} />}
  </View>;
}
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 16, marginBottom: 14 },
  title: { fontSize: 19, lineHeight: 26, fontWeight: '600', marginTop: 4 },
  status: { fontSize: 12, fontWeight: '600' },
  label: { fontSize: 14, fontWeight: '600' },
  detail: { fontSize: 13, lineHeight: 20, marginTop: 7 },
  body: { fontSize: 15, lineHeight: 23, marginTop: 8 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 14, paddingTop: 14 },
  input: { minHeight: 110, maxHeight: 260, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, fontSize: 15, lineHeight: 22, textAlignVertical: 'top', marginTop: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 13, paddingVertical: 10 },
});
