/**
 * A small profile of one person in an imported chat (OpenChat-061g): only
 * what that chat shows, each statement with the messages it came from. Works
 * the same for people who never joined OpenChat and for unnamed participants.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, type ImportedAsk, type ImportedPersonProfile } from '../api/client';
import { Avatar } from '../components/Avatar';
import { AskCard, participantName, SourceQuote, useImportedRoles } from '../components/ImportedChatParts';
import { Button, Card, SectionLabel } from '../components/ui';
import { space, type } from '../theme/tokens';
import { accountLine, coverageLine, membershipLabel, messageTime, mirrorLabel, nameSourceLabel, shortDate } from '../utils/importedChats';
import type { NavProp, RouteProps } from '../navigation/types';

export function ImportedPersonScreen() {
  const navigation = useNavigation<NavProp<'ImportedPerson'>>();
  const { params } = useRoute<RouteProps<'ImportedPerson'>>();
  const r = useImportedRoles();
  const [profile, setProfile] = useState<ImportedPersonProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setProfile(await api.getImportedPerson(params.chatId, params.participantId)); } catch { setError('Could not load this person.'); }
  }, [params.chatId, params.participantId]);
  useEffect(() => { void load(); }, [load]);
  useLayoutEffect(() => { navigation.setOptions({ title: profile ? participantName(profile.person) : 'Person' }); }, [navigation, profile]);
  const openPerson = (participantId: string) => { if (participantId !== params.participantId) navigation.push('ImportedPerson', { chatId: params.chatId, participantId }); };
  const setStatus = async (ask: ImportedAsk, status: ImportedAsk['ownerStatus']) => {
    setBusy(ask.id);
    try { await api.setImportedAskStatus(params.chatId, ask.id, status); await load(); }
    catch { setError('Could not save that status. Try again.'); } finally { setBusy(null); }
  };

  if (!profile) return <View style={[styles.center, { backgroundColor: r.canvas }]}>
    {error ? <><Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>{error}</Text><Button label="Try again" size="sm" onPress={() => void load()} /></> : <ActivityIndicator color={r.accent} />}
  </View>;
  const { person, chat } = profile;
  const span = person.firstMessageAt && person.lastMessageAt ? ` · ${shortDate(person.firstMessageAt)} – ${shortDate(person.lastMessageAt)}` : '';

  return (
    <ScrollView style={{ backgroundColor: r.canvas }} contentContainerStyle={styles.content}>
      <View style={styles.identity}>
        <Avatar name={person.label} size={56} />
        <View style={styles.identityText}>
          <Text style={[type.heading, { color: r.text }]} numberOfLines={2}>{participantName(person)}</Text>
          <Text style={[type.meta, { color: r.textMeta }]}>{nameSourceLabel(person)} · {membershipLabel(person.membership) ?? 'Membership not known'} · {chat.title}</Text>
          <Text style={[type.meta, { color: r.textSecondary }]}>{accountLine(person)}</Text>
          <Text style={[type.meta, { color: r.textMeta }]}>{person.messageCount} {person.messageCount === 1 ? 'message' : 'messages'}{span}</Text>
        </View>
      </View>
      {error ? <Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>{error}</Text> : null}
      {profile.nameSources?.map(source => <SourceQuote key={`name-${source.sourceMessageId}`} source={source} onOpenPerson={openPerson} />)}

      <SectionLabel icon="lock" first>From this chat</SectionLabel>
      {profile.facts.length === 0
        ? <Text style={[type.body, { color: r.textSecondary }]}>Nothing in this chat describes them yet.</Text>
        : profile.facts.map(fact => (
          <Card key={fact.id} style={styles.fact}>
            <Text style={[type.bodyStrong, { color: r.text }]}>{fact.text}</Text>
            {fact.stale ? <Text style={[type.meta, { color: r.textMeta }]}>Not in latest import</Text> : null}
            {fact.sources.map(source => <SourceQuote key={source.sourceMessageId} source={source} onOpenPerson={openPerson} />)}
          </Card>
        ))}

      {profile.asksAbout.length ? <SectionLabel>Their asks</SectionLabel> : null}
      {profile.asksAbout.map(ask => <AskCard key={ask.id} ask={ask} busy={busy === ask.id} onOpenPerson={openPerson} onSetStatus={status => void setStatus(ask, status)} />)}
      {profile.asksReported.length ? <SectionLabel>Asks they passed on</SectionLabel> : null}
      {profile.asksReported.map(ask => <AskCard key={ask.id} ask={ask} busy={busy === ask.id} onOpenPerson={openPerson} onSetStatus={status => void setStatus(ask, status)} />)}

      <SectionLabel>Recent messages</SectionLabel>
      {profile.recentMessages.length === 0 ? <Text style={[type.body, { color: r.textSecondary }]}>No messages from them in this copy.</Text> : null}
      {profile.recentMessages.map(message => (
        <View key={message.id} style={[styles.message, { borderBottomColor: r.line }]}>
          <Text style={[type.meta, { color: r.textMeta }]}>{messageTime(message.sentAt)}</Text>
          <Text style={[type.body, { color: message.text ? r.text : r.textMeta }]} numberOfLines={6}>
            {message.kind === 'deleted' ? 'Deleted by the sender' : message.text ?? (message.mediaType ? `${message.mediaType} · not imported` : 'No text')}
          </Text>
        </View>
      ))}

      <Text style={[type.meta, styles.footer, { color: r.textMeta }]}>
        Only what this chat shows. {mirrorLabel(chat.network)} · {coverageLine(chat.coverage)}. Private to you; they are not told.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[2], padding: space[4] },
  content: { padding: space[4], gap: space[3] },
  identity: { flexDirection: 'row', gap: space[3], alignItems: 'center' },
  identityText: { flex: 1, minWidth: 0, gap: 2 },
  fact: { gap: space[2] },
  message: { paddingVertical: space[2], gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  footer: { marginTop: space[2] },
});
