import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api, type IntentDraft, type OwnedStory } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import type { AsksNavProp } from '../navigation/types';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';
import { AppIcon } from '../components/AppIcon';

type InventoryItem =
  | { key: string; kind: 'draft'; draft: IntentDraft }
  | { key: string; kind: 'story'; story: OwnedStory };

function draftTitle(draft: IntentDraft): string {
  return draft.goal || draft.seeks[0] || draft.brings[0] || 'Private intention';
}

function inventoryExpiry(story: OwnedStory): string {
  const value = (story.humanVisible ? story.storyExpiresAt : null) ?? story.searchExpiresAt;
  return value ? new Date(value).toLocaleDateString() : '';
}

export function AsksScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<AsksNavProp<'AsksList'>>();
  const [drafts, setDrafts] = useState<IntentDraft[]>([]);
  const [stories, setStories] = useState<OwnedStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextDrafts, nextStories] = await Promise.all([
        api.listIntentDrafts(),
        api.listMyStories(),
      ]);
      setDrafts(nextDrafts);
      setStories(nextStories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your intentions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const items = useMemo<InventoryItem[]>(() => [
    ...drafts.filter(draft => draft.state === 'pending').map(draft => ({ key: `draft-${draft.id}`, kind: 'draft' as const, draft })),
    ...stories.filter(story => story.status !== 'withdrawn' && story.status !== 'expired').map(story => ({ key: `story-${story.id}`, kind: 'story' as const, story })),
  ], [drafts, stories]);

  const searchQuietly = async (draft: IntentDraft) => {
    setBusyId(draft.id);
    setError(null);
    try {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
      await api.activateIntentDraft(draft.id, { quietSearch: { enabled: true, expiresAt } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the quiet search.');
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (draft: IntentDraft) => {
    setBusyId(draft.id);
    try {
      await api.updateIntentDraft(draft.id, { state: 'dismissed' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this draft.');
    } finally {
      setBusyId(null);
    }
  };

  const pauseStory = async (story: OwnedStory) => {
    setBusyId(story.id);
    try {
      await api.updateStory(story.id, { status: story.status === 'paused' ? 'active' : 'paused' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this Story.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={styles.hero}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.eyebrow, { color: c.primary }]}>YOUR PRIVATE INVENTORY</Text>
          <Text style={[styles.title, { color: c.textPrimary }]}>Asks, offers & goals</Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]}>Most things stay private. You choose what agents may search and what people may see.</Text>
        </View>
        <TouchableOpacity accessibilityLabel="Tell My Agent something" onPress={() => navigation.navigate('AgentOverlay')} style={[styles.agentButton, { backgroundColor: c.primary }]}>
          <AppIcon name="sparkle" color="#fff" size={18} />
          <Text style={styles.agentButtonText}>Tell My Agent</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={() => navigation.navigate('StoryComposer')} style={[styles.secondaryButton, { borderColor: c.border, backgroundColor: c.surface }]}>
          <AppIcon name="plus" color={c.primary} size={17} />
          <Text style={{ color: c.primary, fontWeight: '700' }}>Share a Story</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('SocialReview')} style={[styles.secondaryButton, { borderColor: c.border, backgroundColor: c.surface }]}>
          <Text style={{ color: c.primary, fontWeight: '700' }}>Review decisions</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => item.key}
          contentContainerStyle={items.length ? styles.list : styles.emptyList}
          ListEmptyComponent={
            <View style={[styles.empty, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>Start with ordinary language</Text>
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>Tell My Agent “I’m looking for a technical cofounder” or “I have an extra ticket.” It stays private until you approve a next step.</Text>
            </View>
          }
          renderItem={({ item }) => item.kind === 'draft' ? (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={styles.cardHeading}>
                <Text style={[styles.state, { color: c.textMuted }]}>PRIVATE DRAFT</Text>
                <Text style={[styles.date, { color: c.textMuted }]}>{new Date(item.draft.updatedAt).toLocaleDateString()}</Text>
              </View>
              <Text style={[styles.cardTitle, { color: c.textPrimary }]}>{draftTitle(item.draft)}</Text>
              {item.draft.seeks.length > 0 && <Text style={[styles.detail, { color: c.textSecondary }]}>Looking for · {item.draft.seeks.join(', ')}</Text>}
              {item.draft.brings.length > 0 && <Text style={[styles.detail, { color: c.textSecondary }]}>Can bring · {item.draft.brings.join(', ')}</Text>}
              <View style={[styles.consentPreview, { borderColor: c.border, backgroundColor: c.background }]}>
                <Text style={[styles.consentTitle, { color: c.textPrimary }]}>Before you approve</Text>
                <Text style={[styles.detail, { color: c.textSecondary }]}>Audience · all eligible agents in your OpenChat network</Text>
                <Text style={[styles.detail, { color: c.textSecondary }]}>Duration · 30 days</Text>
                <Text style={[styles.detail, { color: c.textSecondary }]}>Identity · hidden until both people approve an introduction</Text>
              </View>
              <View style={styles.actions}>
                <TouchableOpacity accessibilityLabel="Search quietly with all eligible agents in your OpenChat network for 30 days; identity stays hidden until both people approve" disabled={busyId === item.draft.id} onPress={() => void searchQuietly(item.draft)} style={[styles.primarySmall, { backgroundColor: c.primary }]}>
                  {busyId === item.draft.id ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.primarySmallText}>Search quietly</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => navigation.navigate('StoryComposer', { draftId: item.draft.id })} style={[styles.outlineSmall, { borderColor: c.border }]}><Text style={{ color: c.primary, fontWeight: '700' }}>Share…</Text></TouchableOpacity>
                <TouchableOpacity disabled={busyId === item.draft.id} onPress={() => void dismiss(item.draft)} style={styles.linkSmall}><Text style={{ color: c.textMuted, fontWeight: '600' }}>Keep private</Text></TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={styles.cardHeading}>
                <Text style={[styles.state, { color: c.primary }]}>{item.story.humanVisible ? 'STORY' : 'QUIET SEARCH'} · {item.story.status.toUpperCase()}</Text>
                <Text style={[styles.date, { color: c.textMuted }]}>{inventoryExpiry(item.story)}</Text>
              </View>
              <Text style={[styles.cardTitle, { color: c.textPrimary }]}>{item.story.humanVisible ? item.story.text : (item.story.goal || item.story.seeks[0] || item.story.brings[0] || 'Agent-only search')}</Text>
              {item.story.humanVisible ? (
                <Text style={[styles.detail, { color: c.textSecondary }]}>
                  {item.story.audience.conversationIds.length} selected chat{item.story.audience.conversationIds.length === 1 ? '' : 's'}{item.story.explicitQuietSearch ? ' · separate quiet search approved' : ''}
                </Text>
              ) : (
                <>
                  {item.story.seeks.length > 0 && <Text style={[styles.detail, { color: c.textSecondary }]}>Looking for · {item.story.seeks.join(', ')}</Text>}
                  {item.story.brings.length > 0 && <Text style={[styles.detail, { color: c.textSecondary }]}>Can bring · {item.story.brings.join(', ')}</Text>}
                  <Text style={[styles.detail, { color: c.textSecondary }]}>Visible to agents only; no human Story was posted.</Text>
                </>
              )}
              <TouchableOpacity disabled={busyId === item.story.id} onPress={() => void pauseStory(item.story)} style={[styles.outlineSmall, { borderColor: c.border, marginTop: 12, alignSelf: 'flex-start' }]}>
                <Text style={{ color: c.primary, fontWeight: '700' }}>{item.story.status === 'paused' ? `Resume ${item.story.humanVisible ? 'Story' : 'search'}` : `Pause ${item.story.humanVisible ? 'Story' : 'search'}`}</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
      {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: { width: '100%', maxWidth: 820, alignSelf: 'center', padding: 18, paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  eyebrow: { ...capsLabel },
  title: { fontFamily: serif, fontSize: 27, fontWeight: '600', marginTop: 4 },
  subtitle: { fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 560 },
  agentButton: { minHeight: 46, borderRadius: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7 },
  agentButtonText: { color: '#fff', fontWeight: '800' },
  toolbar: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 18, paddingBottom: 8, flexDirection: 'row', gap: 8 },
  secondaryButton: { minHeight: 42, paddingHorizontal: 13, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  list: { width: '100%', maxWidth: 820, alignSelf: 'center', padding: 18, paddingTop: 4, paddingBottom: 80, gap: 10 },
  emptyList: { flexGrow: 1, width: '100%', maxWidth: 820, alignSelf: 'center', padding: 18 },
  empty: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 22, marginTop: 20 },
  emptyTitle: { fontFamily: serif, fontSize: 21, fontWeight: '600' },
  emptyText: { fontSize: 14, lineHeight: 21, marginTop: 7 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 17, padding: 16 },
  cardHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  state: { ...capsLabel },
  date: { fontSize: 11 },
  cardTitle: { fontFamily: serif, fontSize: 20, lineHeight: 27, fontWeight: '600', marginTop: 9 },
  detail: { fontSize: 13, lineHeight: 19, marginTop: 6 },
  consentPreview: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 11, marginTop: 12 },
  consentTitle: { fontSize: 12, fontWeight: '800' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 14 },
  primarySmall: { minHeight: 42, minWidth: 116, paddingHorizontal: 13, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  primarySmallText: { color: '#fff', fontWeight: '800' },
  outlineSmall: { minHeight: 42, paddingHorizontal: 13, borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  linkSmall: { minHeight: 42, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  error: { position: 'absolute', left: 18, right: 18, bottom: 12, padding: 10, fontSize: 13 },
});
