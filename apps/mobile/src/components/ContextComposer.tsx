import React, { useRef, useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { contextLaneManager } from '../services/contextLane';
import type { ContextPost } from '../api/client';
import { nanoid } from 'nanoid/non-secure';

export function ContextComposer({ conversationId, replyTo, editing, onDone }: { conversationId: string; replyTo?: ContextPost; editing?: ContextPost; onDone?: () => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [text, setText] = useState(editing?.text ?? '');
  const [kind, setKind] = useState('note');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ text: string; id: string; kind: string; replyToId?: string } | null>(null);
  const sending = useRef(false);

  const handleSend = async () => {
    if (!text.trim() || sending.current) return;
    sending.current = true;
    const value = text.trim();
    if (pending.current?.text !== value || pending.current?.kind !== kind || pending.current?.replyToId !== replyTo?.id) pending.current = { text: value, kind, replyToId: replyTo?.id, id: nanoid() };
    setError(null);
    setIsSending(true);
    try {
      if (editing) await contextLaneManager.updatePost(conversationId, editing.id, value, editing.revision);
      else await contextLaneManager.addPost(conversationId, value, pending.current.id, kind, replyTo?.id);
      pending.current = null;
      setText('');
      onDone?.();
    } catch (e) {
      setError((e as { status?: number })?.status === 409 ? 'This post changed. Your draft is saved here; cancel to reload the latest version before editing again.' : e instanceof Error ? e.message : 'Could not post context. Try again.');
    } finally {
      sending.current = false;
      setIsSending(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: c.surface, borderTopColor: c.border }]}>
      <Text style={{ color: c.textMetadata, fontSize: 12, marginBottom: 8 }}>
        Post quietly — visible to this chat; no notifications.
      </Text>
      {(replyTo || editing) && <View style={{ marginBottom: 8 }}>
        <Text style={{ color: c.textMetadata, fontWeight: '600' }}>{editing ? 'Editing your post' : `Replying to ${replyTo?.author?.name || 'a participant'}`}</Text>
        {replyTo && <Text numberOfLines={2} style={{ color: c.textMetadata }}>{replyTo.text}</Text>}
        <TouchableOpacity accessibilityRole="button" onPress={onDone} disabled={isSending} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: c.primary }}>Cancel {editing ? 'edit' : 'reply'}</Text></TouchableOpacity>
      </View>}
      {!editing && <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        {['note', 'ask', 'offer'].map(value => <TouchableOpacity key={value} accessibilityRole="button" accessibilityState={{ selected: kind === value }} disabled={isSending} onPress={() => setKind(value)} style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 8, justifyContent: 'center', backgroundColor: kind === value ? c.primaryMuted : c.background }}><Text style={{ color: kind === value ? c.primary : c.textMetadata, fontWeight: kind === value ? '600' : '400' }}>{value[0].toUpperCase() + value.slice(1)}</Text></TouchableOpacity>)}
      </View>}
      {kind === 'ask' && !editing && <Text style={{ color: c.textMetadata, fontSize: 12, marginBottom: 8 }}>A question for this chat. Posting alone does not summon agents.</Text>}
      {error && <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text>}
      <View style={[styles.inputRow, { backgroundColor: c.background, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.textPrimary }]}
          placeholder="Add to context..."
          placeholderTextColor={c.textMuted}
          accessibilityLabel={editing ? "Edit context post" : replyTo ? "Reply in context" : "Add to context"}
          editable={!isSending}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={2000}
        />
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: text.trim() ? c.primary : c.primaryMuted }]}
          accessibilityRole="button"
          accessibilityLabel="Post to context"
          onPress={handleSend}
          disabled={!text.trim() || isSending}
        >
          {isSending ? (
            <ActivityIndicator size="small" color={c.onPrimary} />
          ) : (
            <Text style={[styles.sendText, { color: c.onPrimary }]}>{editing ? 'Save' : replyTo ? 'Reply' : 'Post'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      ios: { paddingBottom: 24 },
    }),
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    minHeight: 24,
    maxHeight: 120,
    fontSize: 16,
    paddingTop: 0,
    paddingBottom: 0,
  },
  sendButton: {
    minHeight: 44,
    marginLeft: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendText: {
    fontWeight: '600',
    fontSize: 14,
  },
});
