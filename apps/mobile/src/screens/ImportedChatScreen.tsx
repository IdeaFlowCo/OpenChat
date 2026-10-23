/**
 * One imported chat (OpenChat-061g): the readable conversation, the people in
 * it and their asks. Read-only — there is no composer, and nothing here
 * reaches anyone in the chat. Chats › Imported chats › a chat.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, type ImportedAsk, type ImportedChatSummary, type ImportedMessage, type ImportedPerson } from '../api/client';
import { Avatar } from '../components/Avatar';
import { AskCard, participantName, ProvenanceStrip, useImportedRoles } from '../components/ImportedChatParts';
import { Button, Card, Chip, ListRow } from '../components/ui';
import { space, type } from '../theme/tokens';
import { accountLine, membershipLabel, messageTime, networkName } from '../utils/importedChats';
import type { NavProp, RouteProps } from '../navigation/types';

export type ImportedChatTab = 'conversation' | 'people' | 'asks';
const TABS: Array<{ id: ImportedChatTab; label: string }> = [{ id: 'conversation', label: 'Conversation' }, { id: 'people', label: 'People' }, { id: 'asks', label: 'Asks' }];

export function ImportedChatScreen() {
  const navigation = useNavigation<NavProp<'ImportedChat'>>();
  const { params } = useRoute<RouteProps<'ImportedChat'>>();
  const r = useImportedRoles();
  const [tab, setTab] = useState<ImportedChatTab>(params.tab ?? 'conversation');
  const [chat, setChat] = useState<ImportedChatSummary | null>(null);
  const [error, setError] = useState(false);

  useLayoutEffect(() => { navigation.setOptions({ title: chat?.title ?? params.title ?? 'Imported chat' }); }, [navigation, chat?.title, params.title]);
  const loadChat = useCallback(async () => {
    setError(false);
    try { setChat(await api.getImportedChat(params.chatId)); } catch { setError(true); }
  }, [params.chatId]);
  useEffect(() => { void loadChat(); }, [loadChat]);
  const openPerson = useCallback((participantId: string) => navigation.navigate('ImportedPerson', { chatId: params.chatId, participantId }), [navigation, params.chatId]);

  if (error) return <View style={[styles.center, { backgroundColor: r.canvas }]}>
    <Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>Could not open this imported chat.</Text>
    <Button label="Try again" size="sm" onPress={() => void loadChat()} />
  </View>;
  if (!chat) return <View style={[styles.center, { backgroundColor: r.canvas }]}><ActivityIndicator color={r.accent} /></View>;

  return (
    <View style={[styles.root, { backgroundColor: r.canvas }]}>
      <ProvenanceStrip network={chat.network} coverage={chat.coverage} />
      <View style={[styles.tabs, { borderBottomColor: r.line }]} accessibilityRole="tablist">
        {TABS.map(item => {
          const count = item.id === 'people' ? chat.counts.participants : item.id === 'asks' ? chat.counts.openAsks : null;
          return <Chip key={item.id} label={count ? `${item.label} ${count}` : item.label} selected={tab === item.id} accessibilityLabel={item.label} onPress={() => setTab(item.id)} />;
        })}
      </View>
      {tab === 'conversation' ? <ConversationTab chatId={chat.id} network={chat.network} onOpenPerson={openPerson} /> : null}
      {tab === 'people' ? <PeopleTab chatId={chat.id} onOpenPerson={openPerson} /> : null}
      {tab === 'asks' ? <AsksTab chatId={chat.id} onOpenPerson={openPerson} onChanged={() => void loadChat()} /> : null}
    </View>
  );
}

function ConversationTab({ chatId, network, onOpenPerson }: { chatId: string; network: string; onOpenPerson: (id: string) => void }) {
  const r = useImportedRoles();
  const [messages, setMessages] = useState<ImportedMessage[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(async (before: string | null) => {
    setLoading(true); setError(false);
    try {
      const page = await api.listImportedMessages(chatId, before);
      setMessages(current => before && current ? [...current, ...page.messages] : page.messages);
      setCursor(page.nextCursor);
    } catch { setError(true); } finally { setLoading(false); }
  }, [chatId]);
  useEffect(() => { void load(null); }, [load]);

  if (!messages) return <View style={styles.center}>{error ? <Button label="Try again" size="sm" onPress={() => void load(null)} /> : <ActivityIndicator color={r.accent} />}</View>;
  return (
    <FlatList
      inverted
      data={messages}
      keyExtractor={message => message.id}
      contentContainerStyle={styles.transcript}
      renderItem={({ item }) => <MessageRow message={item} network={network} onOpenPerson={onOpenPerson} />}
      ListHeaderComponent={<Text style={[type.meta, styles.readOnly, { color: r.textMeta }]}>Read-only copy. Nothing here is sent to anyone.</Text>}
      ListFooterComponent={cursor ? <Button label="Load earlier messages" size="sm" variant="ghost" loading={loading} onPress={() => void load(cursor)} style={styles.earlier} /> : null}
      ListEmptyComponent={<Text style={[type.body, { color: r.textSecondary }]}>No messages in this copy.</Text>}
    />
  );
}

/** A transcript row, not a bubble: these were never OpenChat messages. */
export function MessageRow({ message, network, onOpenPerson }: { message: ImportedMessage; network: string; onOpenPerson: (id: string) => void }) {
  const r = useImportedRoles();
  const [showOriginal, setShowOriginal] = useState(false);
  if (message.kind === 'system') {
    return <Text style={[type.meta, styles.system, { color: r.textMeta }]}>{message.text ?? 'Chat event'} · {messageTime(message.sentAt)}</Text>;
  }
  const sender = message.sender;
  return (
    <View style={[styles.message, { borderBottomColor: r.line }]} testID={`imported-message-${message.sourceMessageId}`}>
      <View style={styles.messageHead}>
        {sender
          ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open ${sender.label}`} onPress={() => onOpenPerson(sender.participantId)}>
              <Text style={[type.label, styles.sender, { color: sender.isOwner ? r.accent : r.text }]}>{participantName(sender)}</Text>
            </TouchableOpacity>
          : <Text style={[type.label, { color: r.textMeta }]}>Unknown sender</Text>}
        <Text style={[type.meta, { color: r.textMeta }]}>{messageTime(message.sentAt)}</Text>
      </View>
      {message.kind === 'deleted'
        ? <Text style={[type.body, styles.italic, { color: r.textMeta }]}>Deleted by the sender on {networkName(network)}</Text>
        : <>
            {message.kind === 'media' ? <Text style={[type.meta, { color: r.textMeta }]}>{message.mediaType ? `${message.mediaType[0]!.toUpperCase()}${message.mediaType.slice(1)}` : 'Attachment'} · not imported</Text> : null}
            {message.text ? <Text selectable style={[type.bubble, { color: r.text }]}>{message.text}</Text> : null}
          </>}
      {message.edited ? <View style={styles.edited}>
        <Text style={[type.meta, { color: r.textMeta }]}>Edited{message.editedAt ? ` ${messageTime(message.editedAt)}` : ''}</Text>
        {message.originalText ? <Button label={showOriginal ? 'Hide original' : 'Show original'} size="sm" variant="ghost" onPress={() => setShowOriginal(value => !value)} /> : null}
      </View> : null}
      {showOriginal && message.originalText ? <Text selectable style={[type.body, { color: r.textSecondary }]}>{message.originalText}</Text> : null}
    </View>
  );
}

function PeopleTab({ chatId, onOpenPerson }: { chatId: string; onOpenPerson: (id: string) => void }) {
  const r = useImportedRoles();
  const [people, setPeople] = useState<ImportedPerson[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    setError(false);
    try { setPeople((await api.listImportedPeople(chatId)).people); } catch { setError(true); }
  }, [chatId]);
  useEffect(() => { void load(); }, [load]);
  if (!people) return <View style={styles.center}>{error ? <Button label="Try again" size="sm" onPress={() => void load()} /> : <ActivityIndicator color={r.accent} />}</View>;
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Card padding="none">
        {people.map((person, index) => (
          <ListRow
            key={person.participantId}
            divider={index > 0}
            leading={<Avatar name={person.label} size={36} />}
            title={participantName(person)}
            subtitle={`${membershipLabel(person.membership) ? `${membershipLabel(person.membership)} · ` : ''}${person.messageCount} ${person.messageCount === 1 ? 'message' : 'messages'}${person.askCount ? ` · ${person.askCount} ${person.askCount === 1 ? 'ask' : 'asks'}` : ''} · ${accountLine(person)}`}
            onPress={() => onOpenPerson(person.participantId)}
            testID={`imported-person-${person.participantId}`}
          />
        ))}
      </Card>
    </ScrollView>
  );
}

function AsksTab({ chatId, onOpenPerson, onChanged }: { chatId: string; onOpenPerson: (id: string) => void; onChanged: () => void }) {
  const r = useImportedRoles();
  const [asks, setAsks] = useState<ImportedAsk[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setAsks((await api.listImportedAsks(chatId)).asks); } catch { setError('Could not load asks.'); }
  }, [chatId]);
  useEffect(() => { void load(); }, [load]);
  const setStatus = async (ask: ImportedAsk, status: ImportedAsk['ownerStatus']) => {
    setBusy(ask.id); setError(null);
    try {
      const { ask: updated } = await api.setImportedAskStatus(chatId, ask.id, status);
      setAsks(current => current?.map(item => item.id === updated.id ? updated : item) ?? null);
      onChanged();
    } catch { setError('Could not save that status. Try again.'); } finally { setBusy(null); }
  };
  if (!asks) return <View style={styles.center}>{error ? <Button label="Try again" size="sm" onPress={() => void load()} /> : <ActivityIndicator color={r.accent} />}</View>;
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Text style={[type.meta, { color: r.textMeta }]}>Asks stated in this chat, with the messages that say so. Your status stays when the chat is imported again. Never shared or matched.</Text>
      {error ? <Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>{error}</Text> : null}
      {asks.length === 0 ? <Text style={[type.body, { color: r.textSecondary }]}>No asks recorded for this chat.</Text> : null}
      {asks.map(ask => <AskCard key={ask.id} ask={ask} busy={busy === ask.id} onOpenPerson={onOpenPerson} onSetStatus={status => void setStatus(ask, status)} />)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[2], padding: space[4] },
  tabs: { flexDirection: 'row', gap: space[2], paddingHorizontal: space[4], paddingVertical: space[2], borderBottomWidth: StyleSheet.hairlineWidth },
  transcript: { paddingHorizontal: space[4], paddingVertical: space[2] },
  readOnly: { textAlign: 'center', paddingVertical: space[3] },
  earlier: { alignSelf: 'center', marginVertical: space[2] },
  system: { textAlign: 'center', paddingVertical: space[2] },
  message: { paddingVertical: space[2], gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  messageHead: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  sender: { fontWeight: '600' },
  italic: { fontStyle: 'italic' },
  edited: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  pad: { padding: space[4], gap: space[3] },
});
