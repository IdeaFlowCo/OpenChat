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
export function ContextStreamEntry({ item, conversationId, onChange, onTagPress }: { item: Extract<ConversationContentItem, { origin: 'stream' }>; conversationId: string; onChange: () => void; onTagPress: (tag: string) => void }) {
  const c = getColors(useTheme().scheme), navigation = useNavigation<NavProp<'ConversationThoughts'>>();
  const { currentUser } = useChat(); const t = item.thought, own = t.authorId === currentUser?.userId;
  const [editing, setEditing] = useState(false), [share, setShare] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = useRef(false);
  const change = async (fn: () => Promise<unknown>) => {
    if (running.current) return; running.current = true; setBusy(true); setError('');
    try { await fn(); setShare(undefined); onChange(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not update this entry.'); } finally { running.current = false; setBusy(false); }
  };
  return <View style={{ marginBottom: 10 }}>
    <Text style={{ color: c.textMetadata, fontSize: 12, marginBottom: 6 }}>{item.visibility === 'private' ? 'Only you' : 'Shared with this chat'} · {item.provenance === 'pinned' ? 'Pinned Stream entry' : item.provenance === 'message_capture' ? 'Stream · message capture' : 'Private Stream entry'}</Text>
    {editing ? <ConversationEntryEditor conversationId={conversationId} thought={t} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChange(); }} /> : <ThoughtCard item={t} subtitle={`by ${t.authorName || 'a participant'}`} onPress={own ? () => setEditing(true) : undefined} onDelete={own ? () => void change(() => api.deleteThought(t.id)) : undefined} onTagPress={onTagPress}
      onOpenContext={t.sourceMessageId ? () => navigation.navigate('OriginalMessage', { thoughtId: t.id }) : undefined} />}
    {t.hasSourceMessage && !t.sourceMessageId && <Text style={{ color: c.textMetadata, fontSize: 12 }}>Original message unavailable</Text>}
    {(own || (t.pinned && t.pinnedBy === currentUser?.userId)) && !editing && <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => t.pinned ? void change(() => api.unpinThought(t.id, conversationId)) : setShare(t.text)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 }}><Text style={{ color: c.primary }}>{t.pinned ? 'Unpin from chat' : item.visibility === 'private' ? 'Share & pin…' : 'Pin to chat…'}</Text></TouchableOpacity>}
    {share !== undefined && <View style={{ padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface }}>
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
