import React, { useState } from 'react';
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

  const handleSend = async () => {
    if (!text.trim() || isSending) return;
    setIsSending(true);
    try {
      await contextLaneManager.addPost(conversationId, text.trim(), nanoid());
      setText('');
    } catch (e) {
      console.warn('Failed to post context', e);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: c.surface, borderTopColor: c.border }]}>
      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 8 }}>
        Post quietly — visible to this chat; no notifications.
      </Text>
      <View style={[styles.inputRow, { backgroundColor: c.background, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.textPrimary }]}
          placeholder="Add to context..."
          placeholderTextColor={c.textMuted}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={2000}
        />
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: text.trim() ? c.primary : c.primaryMuted }]}
          onPress={handleSend}
          disabled={!text.trim() || isSending}
        >
          {isSending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.sendText}>Post</Text>
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
    marginLeft: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
