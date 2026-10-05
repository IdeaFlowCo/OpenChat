import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { CommonActions, useRoute } from '@react-navigation/native';
import { navigationRef } from '../services/notifications';
import { api } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { RouteProps } from '../navigation/types';

/** Read-only original context. A saved capture never grants access to its source. */
export function OriginalMessageScreen() {
  const { params } = useRoute<RouteProps<'OriginalMessage'>>();
  const { scheme } = useTheme(); const c = getColors(scheme);
  const [context, setContext] = useState<Awaited<ReturnType<typeof api.getThoughtContext>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true; setContext(null); setError('');
    api.getThoughtContext(params.thoughtId).then(value => { if (current) setContext(value); }).catch(() => {
      if (current) setError('Original message unavailable. It may have been deleted, or you may no longer have access to its chat.');
    });
    return () => { current = false; };
  }, [params.thoughtId]);
  return <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={{ padding: 20 }}>
    <Text style={{ color: c.textPrimary, fontSize: 22, fontWeight: '600' }}>Original message</Text>
    {!!error && <Text style={{ color: c.textMetadata, marginTop: 18 }}>{error}</Text>}
    {!context && !error && <ActivityIndicator color={c.primary} />}
    {context && <>
      <Text style={{ color: c.textMetadata, marginVertical: 16 }}>{context.conversation.name || 'Original chat'}</Text>
      {context.messages.map(m => <View key={m.id} style={{ padding: 14, marginBottom: 8, borderRadius: 10, backgroundColor: m.id === context.messageId ? c.primaryMuted : c.surface, borderWidth: m.id === context.messageId ? 2 : 1, borderColor: m.id === context.messageId ? c.primary : c.border }}>
        {m.id === context.messageId && <Text style={{ color: c.primary, fontWeight: '600' }}>Saved message</Text>}
        <Text style={{ color: c.textMetadata, marginBottom: 6 }}>{m.senderName || 'Participant'} · {new Date(m.createdAt).toLocaleString()}</Text>
        <Text style={{ color: c.textPrimary, fontSize: 15 }}>{m.content}</Text>
      </View>)}
      <TouchableOpacity onPress={() => navigationRef.dispatch(CommonActions.navigate({ name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Chat', params: { conversationId: context.conversation.id } } } }))} accessibilityRole="button" style={{ paddingVertical: 16 }}><Text style={{ color: c.primary, fontWeight: '600' }}>Open chat</Text></TouchableOpacity>
    </>}
  </ScrollView>;
}
