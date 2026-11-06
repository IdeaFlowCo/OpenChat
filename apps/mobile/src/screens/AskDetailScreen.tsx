import { AskPublicationControls } from '../components/AskPublicationControls';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { api, type OverlayAsk } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, type } from '../theme/tokens';
import { askMeta, askParties } from '../components/PeopleAsks';
import type { AsksNavProp, AsksRouteProps } from '../navigation/types';

export function AskDetailScreen() {
  const { currentUser } = useChat();
  const { params } = useRoute<AsksRouteProps<'AskDetail'>>();
  return currentUser ? <AskDetail key={`${currentUser.userId}:${params.askId}`} askId={params.askId} /> : null;
}
function AskDetail({ askId }: { askId: string }) {
  const c = getColors(useTheme().scheme);
  const navigation = useNavigation<AsksNavProp<'AskDetail'>>();
  const [ask, setAsk] = useState<OverlayAsk | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    let active = true;
    void api.getAsk(askId).then(result => { if (active) { setAsk(result.ask); setError(null); } }).catch(err => { if (active) { setAsk(null); setError(err instanceof Error ? err.message : 'Ask unavailable'); } });
    return () => { active = false; };
  }, [askId]));
  return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={{ padding: space[4], gap: space[3] }}>
    {error ? <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text> : !ask ? <ActivityIndicator color={c.primary} /> : <>
      <Text style={{ ...type.heading, color: c.textPrimary }}>{ask.text}</Text>
      <Text style={{ ...type.body, color: c.textMetadata }}>{askMeta(ask)}</Text>
      {!!askParties(ask) && <Text style={{ ...type.body, color: c.textSecondary }}>{askParties(ask)}</Text>}
      <Text style={{ ...type.label, color: c.textMetadata }}>Recorded by {ask.recordedBy ?? 'unknown'} · {ask.recordedVia ?? 'unknown source'}</Text>
      {ask.evidence?.quote && <Text style={{ ...type.body, color: c.textSecondary }}>{ask.evidence.quote}</Text>}
      <AskPublicationControls ask={ask} />
      <Text style={{ ...type.heading, color: c.textPrimary }}>Sources</Text>
      {!ask.sources?.length && <Text style={{ ...type.body, color: c.textMetadata }}>No message receipt was recorded by the original client.</Text>}
      {ask.sources?.map(source => <TouchableOpacity key={`${source.app}:${source.conversationId}:${source.messageId}:${source.itemIndex}`} accessibilityRole="link" disabled={source.app !== 'openchat'} onPress={() => navigation.navigate('Chat', { conversationId: source.conversationId })} style={{ paddingVertical: space[3], gap: space[2] }}>
        <Text style={{ ...type.body, color: c.textPrimary }}>{source.excerpt}</Text>
        <Text style={{ ...type.meta, color: c.textMetadata }}>{source.assertion} · {source.app} · {new Date(source.recordedAt).toLocaleDateString()}</Text>
        <Text style={{ ...type.label, color: c.primary }}>{source.app === 'openchat' ? 'Open source conversation' : source.app}</Text>
      </TouchableOpacity>)}
    </>}
  </ScrollView>;
}
