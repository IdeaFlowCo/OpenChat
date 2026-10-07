import React, { useRef, useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { contextLaneManager } from '../services/contextLane';
import { nanoid } from 'nanoid/non-secure';

export function ContextComposer({ conversationId }: { conversationId: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ text: string; id: string } | null>(null);
  const sending = useRef(false);

  const handleSend = async () => {
    if (!text.trim() || sending.current) return;
    sending.current = true;
    const value = text.trim();
    if (pending.current?.text !== value) pending.current = { text: value, id: nanoid() };
    setError(null);
    setIsSending(true);
    try {
      await contextLaneManager.addPost(conversationId, value, pending.current.id);
      pending.current = null;
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post context. Try again.');
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
      {error && <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: c.danger, marginBottom: 8 }}>{error}</Text>}
      <View style={[styles.inputRow, { backgroundColor: c.background, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.textPrimary }]}
          placeholder="Add to context..."
          placeholderTextColor={c.textMuted}
          accessibilityLabel="Add to context"
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
            <Text style={[styles.sendText, { color: c.onPrimary }]}>Post</Text>
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
