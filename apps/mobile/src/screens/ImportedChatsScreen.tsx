/**
 * Imported chats — the owner's private, read-only copies of chats from other
 * networks (OpenChat-061g). Chats › Imported chats.
 */
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api, type ImportedChatSummary } from '../api/client';
import { useImportedRoles } from '../components/ImportedChatParts';
import { Button, Card, ListRow } from '../components/ui';
import { space, type } from '../theme/tokens';
import { coverageLine, mirrorLabel } from '../utils/importedChats';
import type { NavProp } from '../navigation/types';

export function ImportedChatsScreen() {
  const navigation = useNavigation<NavProp<'ImportedChats'>>();
  const r = useImportedRoles();
  const [chats, setChats] = useState<ImportedChatSummary[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try { setChats((await api.listImportedChats()).chats); } catch { setError(true); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <ScrollView style={{ backgroundColor: r.canvas }} contentContainerStyle={styles.content}>
      <Text style={[type.meta, { color: r.textMeta }]}>
        Private copies of chats from other apps. Only you see them. Nothing here is sent, and nobody in them is invited or notified.
      </Text>
      {error ? <View style={styles.error}>
        <Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>Could not load imported chats.</Text>
        <Button label="Try again" size="sm" onPress={() => void load()} />
      </View> : null}
      {!chats && !error ? <ActivityIndicator color={r.accent} /> : null}
      {chats && chats.length === 0 ? <Text style={[type.body, { color: r.textSecondary }]}>No imported chats yet.</Text> : null}
      {chats && chats.length > 0 ? (
        <Card padding="none">
          {chats.map((chat, index) => (
            <ListRow
              key={chat.id}
              icon="download"
              divider={index > 0}
              title={chat.title}
              subtitle={`${mirrorLabel(chat.network)}\n${coverageLine(chat.coverage)} · ${chat.counts.participants} people · ${chat.counts.openAsks} open asks`}
              accessibilityLabel={`${chat.title}, ${mirrorLabel(chat.network)}`}
              onPress={() => navigation.navigate('ImportedChat', { chatId: chat.id, title: chat.title })}
            />
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space[4], gap: space[3] },
  error: { gap: space[2], alignItems: 'flex-start' },
});
