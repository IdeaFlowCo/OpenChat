import React, { useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { api, type ConversationContentItem, type Thought } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';
import { ThoughtCard } from './ThoughtCard';
import { StreamTextInput } from './StreamEditor';
import { StreamCardHeader } from './StreamCardHeader';
import { type } from '../theme/tokens';

/** Same paper surface/14px metadata/44px words as Context; audience leads every saved entry. */
export function ConversationEntryEditor({ conversationId, thought, onDone, onCancel }: { conversationId: string; thought?: Thought; onDone: () => void; onCancel: () => void }) {
  const c = getColors(useTheme().scheme);
  const [text, setText] = useState(thought?.text || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const save = async () => {
    if (saving.current || !text.trim()) return;
    saving.current = true; setBusy(true); setError('');
    try { if (thought) await api.updateThought(thought.id, { text: text.trim() }); else await api.createThought({ text: text.trim(), scopeConversationId: conversationId }); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save entry. Your draft is still here.'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <View style={{ padding: 12, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 8, marginBottom: 12 }}>
    <Text style={{ color: c.textPrimary, fontWeight: '600' }}>{thought ? 'Edit Stream entry' : 'New private Stream entry'}</Text>
    <Text style={{ color: c.textMetadata, marginVertical: 8 }}>{thought ? 'This preserves the entry’s current sharing. Saving does not add an audience.' : 'Only you can read this entry. Saving does not post to Context or pin it to this chat.'}</Text>
    <StreamTextInput accessibilityLabel="Stream entry text" value={text} onChangeText={setText} conversationId={conversationId} editable={!busy} multiline maxLength={20000} style={{ minHeight: 100, color: c.textPrimary, padding: 10, backgroundColor: c.background }} />
    {error ? <Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <TouchableOpacity accessibilityRole="button" disabled={busy || !text.trim()} onPress={() => void save()} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: c.primary }}>{busy ? 'Saving…' : 'Save entry'}</Text></TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCancel} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: c.primary }}>Cancel</Text></TouchableOpacity>
    </View>
  </View>;
}
export function ContextStreamEntry({ item, conversationId, sharedScope, announcementReadOnly=false, onChange, onTagPress }: { item: Extract<ConversationContentItem, { origin: 'stream' }>; conversationId: string; sharedScope?: string; announcementReadOnly?: boolean; onChange: () => void; onTagPress: (tag: string) => void }) {
  const c = getColors(useTheme().scheme), navigation = useNavigation<NavProp<'ConversationThoughts'>>();
  const { currentUser } = useChat(); const t = item.thought, own = t.authorId === currentUser?.userId;
  const mayEdit=own&&!(announcementReadOnly&&item.visibility==='conversation');
  const [editing, setEditing] = useState(false), [share, setShare] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = useRef(false);
  const change = async (fn: () => Promise<unknown>) => {
    if (running.current) return; running.current = true; setBusy(true); setError('');
    try { await fn(); setShare(undefined); onChange(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not update this entry.'); } finally { running.current = false; setBusy(false); }
  };
  const kind = item.provenance === 'pinned' ? 'Pinned' : item.provenance === 'message_capture' ? 'From a message' : 'Stream entry';
  const openSource = t.sourceMessageId ? () => navigation.navigate('OriginalMessage', { thoughtId: t.id }) : undefined;
  return <View style={{ marginBottom: 8 }}>
    {editing&&mayEdit ? <ConversationEntryEditor conversationId={conversationId} thought={t} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChange(); }} /> : <ThoughtCard item={t} tinted={item.visibility === 'private'}
      header={controls => <StreamCardHeader name={own ? 'You' : t.authorName || 'A participant'} avatarName={t.authorName || undefined} createdAt={t.createdAt} audience={item.visibility === 'private' ? 'private' : 'shared'} sharedScope={sharedScope} kind={kind} onOpenSource={openSource} trailing={controls} />}
      onPress={mayEdit ? () => setEditing(true) : undefined} onDelete={mayEdit ? () => void change(() => api.deleteThought(t.id)) : undefined} onTagPress={onTagPress}
      onOpenContext={openSource} />}
    {t.hasSourceMessage && !t.sourceMessageId && <Text style={{ color: c.textMetadata, fontSize: 12 }}>Original message unavailable</Text>}
    {!announcementReadOnly&&(own || (t.pinned && t.pinnedBy === currentUser?.userId)) && !editing && <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => t.pinned ? void change(() => api.unpinThought(t.id, conversationId)) : setShare(t.text)} hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }} style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center', paddingHorizontal: 12 }}><Text style={[type.label, { color: c.primary }]}>{t.pinned ? 'Unpin from chat' : item.visibility === 'private' ? 'Share & pin…' : 'Pin to chat…'}</Text></TouchableOpacity>}
    {!announcementReadOnly&&share !== undefined && <View style={{ padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface }}>
      <Text style={{ color: c.textPrimary, fontWeight: '600' }}>Share and pin this exact entry?</Text>
      <Text selectable style={{ color: c.textPrimary, marginVertical: 8 }}>{share}</Text>
      <Text style={{ color: c.textMetadata }}>Current and future authorized members of this conversation can read the pinned entry. This does not send a chat message.</Text>
      {share !== t.text && <Text accessibilityRole="alert" style={{ color: c.danger }}>Entry changed. Cancel and review the current text before sharing.</Text>}
      <TouchableOpacity accessibilityRole="button" disabled={busy || share !== t.text} onPress={() => void change(() => api.pinThought(t.id, conversationId, share))} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: c.primary }}>Share & pin to this chat</Text></TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => setShare(undefined)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: c.primary }}>Cancel sharing</Text></TouchableOpacity>
    </View>}
    {error ? <Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text> : null}
  </View>;
}
