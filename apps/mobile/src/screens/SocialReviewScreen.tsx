import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api, type SocialReviewItem } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import type { NavProp } from '../navigation/types';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';

function itemTitle(item: SocialReviewItem): string {
  return item.kind === 'match' ? item.match.otherTerms : item.title;
}

function itemLabel(item: SocialReviewItem): string {
  switch (item.kind) {
    case 'draft': return 'PRIVATE SUGGESTION';
    case 'match': return 'POSSIBLE MATCH';
    case 'expiring_story': return 'STORY EXPIRING';
  }
}

export function SocialReviewScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'SocialReview'>>();
  const { respondToAgentMatch, refreshConversations } = useChat();
  const [items, setItems] = useState<SocialReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getSocialReview();
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Review.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const act = async (item: SocialReviewItem, action: 'approve' | 'decline' | 'search' | 'private' | 'extend') => {
    const id = item.id;
    setBusy(id);
    setError(null);
    try {
      if (item.kind === 'match') {
        const match = await respondToAgentMatch(item.match.id, action === 'approve' ? 'approve' : 'decline');
        if (match.conversationId) {
          await refreshConversations();
          navigation.replace('Chat', { conversationId: match.conversationId });
          return;
        }
      } else if (item.kind === 'draft') {
        if (action === 'search') {
          await api.activateIntentDraft(item.draft.id, {
            quietSearch: { enabled: true, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString() },
          });
        } else {
          await api.updateIntentDraft(item.draft.id, { state: 'dismissed' });
        }
      } else if (item.kind === 'expiring_story') {
        const currentExpiry = item.dueAt ? Date.parse(item.dueAt) : Date.now();
        const extensionBase = Number.isFinite(currentExpiry) ? Math.max(Date.now(), currentExpiry) : Date.now();
        await api.updateStory(item.storyId, { storyExpiresAt: new Date(extensionBase + 24 * 3_600_000).toISOString() });
      } else {
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this item.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={styles.hero}>
        <Text style={[styles.eyebrow, { color: c.primary }]}>ONLY THINGS NEEDING YOU</Text>
        <Text style={[styles.title, { color: c.textPrimary }]}>Review</Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>Suggestions are private. Matches reveal identities only after both people approve.</Text>
      </View>
      {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 50 }} /> : (
        <FlatList
          data={items}
          keyExtractor={(item, index) => `${item.kind}-${index}-${itemTitle(item)}`}
          contentContainerStyle={items.length ? styles.list : styles.emptyList}
          ListEmptyComponent={
            <View style={[styles.empty, { borderColor: c.border, backgroundColor: c.surface }]}>
              <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>You’re caught up</Text>
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>Private memory and routine agent work stay out of this queue until a decision is actually needed.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const id = item.id;
            return (
              <View style={[styles.card, { borderColor: item.priority === 'action' ? c.primary : c.border, backgroundColor: c.surface }]}>
                <Text style={[styles.label, { color: item.priority === 'action' ? c.primary : c.textMuted }]}>{itemLabel(item)}</Text>
                <Text style={[styles.cardTitle, { color: c.textPrimary }]}>{itemTitle(item)}</Text>
                {item.kind === 'match' && <Text style={[styles.detail, { color: c.textSecondary }]}>Matched with your {item.match.ownIntent.kind}: {item.match.ownIntent.terms}</Text>}
                {item.kind === 'draft' && item.draft.seeks.length > 0 && <Text style={[styles.detail, { color: c.textSecondary }]}>Looking for · {item.draft.seeks.join(', ')}</Text>}
                {item.kind === 'draft' && item.draft.brings.length > 0 && <Text style={[styles.detail, { color: c.textSecondary }]}>You can bring · {item.draft.brings.join(', ')}</Text>}
                {item.kind === 'draft' && (
                  <View style={[styles.consentPreview, { borderColor: c.border, backgroundColor: c.background }]}>
                    <Text style={[styles.consentTitle, { color: c.textPrimary }]}>Before you approve</Text>
                    <Text style={[styles.detail, { color: c.textSecondary }]}>Audience · all eligible agents in your OpenChat network</Text>
                    <Text style={[styles.detail, { color: c.textSecondary }]}>Duration · 30 days</Text>
                    <Text style={[styles.detail, { color: c.textSecondary }]}>Identity · hidden until both people approve an introduction</Text>
                  </View>
                )}
                <View style={styles.actions}>
                  {item.kind === 'match' && (
                    <>
                      <TouchableOpacity disabled={busy === id} onPress={() => void act(item, 'approve')} style={[styles.primary, { backgroundColor: c.primary }]}><Text style={styles.primaryText}>Approve intro</Text></TouchableOpacity>
                      <TouchableOpacity disabled={busy === id} onPress={() => void act(item, 'decline')} style={[styles.secondary, { borderColor: c.border }]}><Text style={{ color: c.textSecondary, fontWeight: '700' }}>Pass</Text></TouchableOpacity>
                    </>
                  )}
                  {item.kind === 'draft' && (
                    <>
                      <TouchableOpacity accessibilityLabel="Search quietly with all eligible agents in your OpenChat network for 30 days; identity stays hidden until both people approve" disabled={busy === id} onPress={() => void act(item, 'search')} style={[styles.primary, { backgroundColor: c.primary }]}><Text style={styles.primaryText}>Search quietly</Text></TouchableOpacity>
                      <TouchableOpacity onPress={() => navigation.navigate('StoryComposer', { draftId: item.draft.id })} style={[styles.secondary, { borderColor: c.border }]}><Text style={{ color: c.primary, fontWeight: '700' }}>Share…</Text></TouchableOpacity>
                      <TouchableOpacity disabled={busy === id} onPress={() => void act(item, 'private')} style={styles.link}><Text style={{ color: c.textMuted, fontWeight: '600' }}>Keep private</Text></TouchableOpacity>
                    </>
                  )}
                  {item.kind === 'expiring_story' && <TouchableOpacity disabled={busy === id} onPress={() => void act(item, 'extend')} style={[styles.primary, { backgroundColor: c.primary }]}><Text style={styles.primaryText}>Add 24 hours</Text></TouchableOpacity>}
                  {busy === id && <ActivityIndicator color={c.primary} />}
                </View>
              </View>
            );
          }}
        />
      )}
      {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 20, paddingBottom: 8 },
  eyebrow: { ...capsLabel },
  title: { fontFamily: serif, fontSize: 30, fontWeight: '600', marginTop: 4 },
  subtitle: { fontSize: 13, lineHeight: 20, marginTop: 5, maxWidth: 560 },
  list: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 18, paddingTop: 8, gap: 10, paddingBottom: 80 },
  emptyList: { flexGrow: 1, width: '100%', maxWidth: 760, alignSelf: 'center', padding: 18 },
  empty: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 22, marginTop: 20 },
  emptyTitle: { fontFamily: serif, fontSize: 21, fontWeight: '600' },
  emptyText: { fontSize: 14, lineHeight: 21, marginTop: 7 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 17, padding: 16 },
  label: { ...capsLabel },
  cardTitle: { fontFamily: serif, fontSize: 20, lineHeight: 27, fontWeight: '600', marginTop: 8 },
  detail: { fontSize: 13, lineHeight: 19, marginTop: 6 },
  consentPreview: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 11, marginTop: 12 },
  consentTitle: { fontSize: 12, fontWeight: '800' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 14 },
  primary: { minHeight: 42, borderRadius: 11, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontWeight: '800' },
  secondary: { minHeight: 42, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  link: { minHeight: 42, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  error: { position: 'absolute', left: 18, right: 18, bottom: 10, fontSize: 13, padding: 10 },
});
