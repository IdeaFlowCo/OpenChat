import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { CommonActions, useRoute } from '@react-navigation/native';
import { navigationRef } from '../services/notifications';
import { api } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { MessageText } from '../components/MessageText';
import type { RouteProps } from '../navigation/types';

/** Read-only source context. A capture or message URL never grants access. */
export function OriginalMessageScreen() {
  const { params } = useRoute<RouteProps<'OriginalMessage'>>();
  const linkedMessageId = 'messageId' in params ? params.messageId : null;
  const thoughtId = 'thoughtId' in params ? params.thoughtId : null;
  const { scheme } = useTheme(); const c = getColors(scheme);
  const [context, setContext] = useState<Awaited<ReturnType<typeof api.getMessageContext>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true; setContext(null); setError('');
    const request = linkedMessageId ? api.getMessageContext(linkedMessageId) : api.getThoughtContext(thoughtId!);
    request.then(value => { if (current) setContext(value); }).catch(() => {
      if (current) setError('Message unavailable. It may have been deleted, or you may no longer have access to its chat.');
    });
    return () => { current = false; };
  }, [linkedMessageId, thoughtId]);
  return <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={{ padding: space[5] }}>
    <Text style={{ ...type.title, color: c.textPrimary }}>{linkedMessageId ? 'Linked message' : 'Original message'}</Text>
    {!!error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.textMetadata, marginTop: space[4] }}>{error}</Text>}
    {!context && !error && <ActivityIndicator accessibilityLabel="Loading message" color={c.primary} />}
    {context && <>
      <Text style={{ ...type.body, color: c.textMetadata, marginVertical: space[4] }}>{context.conversation.name || 'Original chat'}</Text>
      <Text style={{ ...type.meta, color: c.textMetadata, marginBottom: space[3] }}>Only people with access to this chat can open this message link.</Text>
      {context.messages.map(m => <View key={m.id} accessibilityLabel={m.id === context.messageId ? 'Linked message' : undefined} style={{ padding: space[4], marginBottom: space[2], borderRadius: radius.md, backgroundColor: m.id === context.messageId ? c.primaryMuted : c.surface, borderWidth: m.id === context.messageId ? 2 : 1, borderColor: m.id === context.messageId ? c.primary : c.border }}>
        {m.id === context.messageId && <Text style={{ ...type.label, color: c.primary }}>{linkedMessageId ? 'Linked message' : 'Saved message'}</Text>}
        <Text style={{ ...type.meta, color: c.textMetadata, marginBottom: space[2] }}>{m.senderName || 'Participant'} · {new Date(m.createdAt).toLocaleString()}</Text>
        <MessageText content={m.content || 'Attachment or voice message · open chat to view'} color={c.textPrimary} onLongPress={() => undefined} />
      </View>)}
      <TouchableOpacity onPress={() => navigationRef.dispatch(CommonActions.navigate({ name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Chat', params: { conversationId: context.conversation.id } } } }))} accessibilityRole="button" style={{ paddingVertical: space[4] }}><Text style={{ ...type.label, color: c.primary }}>Open chat</Text></TouchableOpacity>
    </>}
  </ScrollView>;
}
