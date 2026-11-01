/**
 * Stream list screen — shows the user's personal notes feed. (OpenChat-zi1)
 *
 * NoteStream-style inline editing (2026-09-02, Jacob): entries are edited and
 * written IN the list — no modal.
 *
 * - FAB (+) → empty editor card appears at the top; type, tap away to save
 * - Tap a card → edit its text in place; tap away to save
 * - Long-press a card (or right-click on web) → available entry actions
 * - Pull-to-refresh
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { fetchThoughts, createThought, updateThought, deleteThought, searchVision, Thought } from '../services/thoughts';
import { getSocket } from '../api/socket';
import { StreamEditor } from '../components/StreamEditor';
import { ThoughtCard } from '../components/ThoughtCard';
import { VisionNoteCard } from '../components/VisionNoteCard';
import { Button, Chip } from '../components/ui';
import { space, type } from '../theme/tokens';
import {
  VISION_SEARCH_DEBOUNCE_MS,
  VISION_UNAVAILABLE_NOTICE,
  appendVisionRows,
  classifyUnavailable,
  mergeStreamItems,
  nextAvailability,
  type StreamItem,
  type VisionAvailability,
  type VisionChip,
  type VisionSearchRow,
} from '../utils/visionSearch';
import { ThoughtsSearchBar } from '../components/ThoughtsSearchBar';
import { StreamCompactToggle } from '../components/StreamCompactToggle';
import { applyCollapsed, ingestStreamCollapsed } from '../services/streamDisplay';
import type { ThoughtsNavProp } from '../navigation/types';
import { AppIcon } from '../components/AppIcon';
import { streamErrorMessage } from './streamError';

// ── ThoughtsScreen ────────────────────────────────────────────────────────────

export function ThoughtsScreen() {
  const { currentUser } = useChat();
  const viewer = currentUser?.userId;
  const navigation = useNavigation<ThoughtsNavProp<'ThoughtsList'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const mountedRef = useRef(true);

  // ── Vision-backed search ──────────────────────────────────────────────────
  // `availability` is remembered for the screen session: once the server says
  // the user has no Vision we stop calling it on every keystroke.
  const [availability, setAvailability] = useState<VisionAvailability>('unknown');
  const availabilityRef = useRef<VisionAvailability>('unknown');
  const [chip, setChip] = useState<VisionChip>('openchat');
  const [visionRows, setVisionRows] = useState<VisionSearchRow[]>([]);
  const [visionCursor, setVisionCursor] = useState<string | null>(null);
  // True only when the latest search for the current query got rows from Vision.
  const [visionOk, setVisionOk] = useState(false);
  const [visionNotice, setVisionNotice] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  // The query currently reflected in `thoughts`. Used so socket-pushed
  // thought:created events only prepend when we're showing the full list.
  const activeQueryRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; searchAbortRef.current?.abort(); };
  }, []);

  const load = useCallback(async (isRefresh = false, q = '') => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const trimmed = q.trim();
      const data = await fetchThoughts({ limit: 50, ...(trimmed ? { q: trimmed } : {}) });
      if (mountedRef.current) {
        if (viewer) ingestStreamCollapsed(viewer, data);
        activeQueryRef.current = trimmed;
        setThoughts(data);
      }
    } catch (e) {
      if (mountedRef.current) setError(streamErrorMessage(e, 'Failed to load Stream'));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [viewer]);

  // Reload whenever the screen comes into focus (e.g., returning from add/edit),
  // honoring whatever search query is active. We read the query from a ref so
  // this effect doesn't re-fire on every keystroke (the debounce below owns that).
  const queryRef = useRef('');
  queryRef.current = query;
  useFocusEffect(useCallback(() => { load(false, queryRef.current); }, [load]));

  // Debounced search. A non-empty query waits 300 ms, then runs the local
  // :Thought search and (unless the user has no Vision) the Vision search in
  // parallel. Clearing the input falls back to the normal full list. Skipped
  // on first mount — the focus effect already did the initial load.
  const resetVision = useCallback(() => {
    searchSeqRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setVisionRows([]);
    setVisionCursor(null);
    setVisionOk(false);
    setVisionNotice(false);
    setLoadingMore(false);
    setLoadMoreFailed(false);
  }, []);

  const runVisionSearch = useCallback(async (q: string, which: VisionChip) => {
    const seq = ++searchSeqRef.current;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setLoadMoreFailed(false);
    setLoadingMore(false);
    const result = await searchVision({ q, chip: which }, controller.signal);
    // Stale (aborted, superseded or unmounted): ignore.
    if (!result || seq !== searchSeqRef.current || !mountedRef.current) return;
    const next = nextAvailability(availabilityRef.current, result);
    availabilityRef.current = next;
    setAvailability(next);
    if (result.status === 'ok') {
      setVisionRows(result.rows);
      setVisionCursor(result.nextCursor);
      setVisionOk(true);
      setVisionNotice(false);
    } else {
      setVisionRows([]);
      setVisionCursor(null);
      setVisionOk(false);
      // No Vision at all is silent; any other failure is called out.
      setVisionNotice(classifyUnavailable(result.code) === 'degraded');
    }
  }, []);

  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      resetVision();
      const timer = setTimeout(() => { load(false, query); }, 250);
      return () => clearTimeout(timer);
    }
    // Supersede any in-flight Vision search now, not after the debounce, so an
    // older query's or chip's rows (and cursor) can never land on this one.
    searchSeqRef.current += 1;
    searchAbortRef.current?.abort();
    const timer = setTimeout(() => {
      load(false, query);
      if (availabilityRef.current !== 'none') void runVisionSearch(trimmed, chip);
      else resetVision();
    }, VISION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, chip, load, runVisionSearch, resetVision]);

  const selectChip = useCallback((next: VisionChip) => {
    if (next === chip) return;
    // Rows from the other filter must not linger while the new search runs.
    searchSeqRef.current += 1;
    searchAbortRef.current?.abort();
    setLoadingMore(false);
    setVisionRows([]);
    setVisionCursor(null);
    setVisionOk(false);
    setChip(next);
  }, [chip]);

  const loadMoreVision = useCallback(async () => {
    const trimmed = query.trim();
    if (!visionCursor || loadingMore || !trimmed) return;
    const seq = searchSeqRef.current;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    const result = await searchVision({ q: trimmed, chip, cursor: visionCursor }, controller.signal);
    if (!result || seq !== searchSeqRef.current || !mountedRef.current) return;
    setLoadingMore(false);
    if (result.status === 'ok') {
      setVisionRows((prev) => appendVisionRows(prev, result.rows));
      setVisionCursor(result.nextCursor);
    } else {
      setLoadMoreFailed(true);
    }
  }, [query, visionCursor, loadingMore, chip]);

  // Live update on tag-generated Thoughts: server emits 'thought:created'
  // when a chat message with a hashtag spawns a new Thought. Prepend so
  // newest-first ordering matches the load() fetch.
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onCreated = (payload: { thought: Thought }) => {
      if (!payload?.thought) return;
      if (viewer) ingestStreamCollapsed(viewer, [payload.thought]);
      // While a search is active the list is filtered server-side; don't
      // blindly prepend a new thought that may not match the query.
      if (activeQueryRef.current) return;
      setThoughts((prev) => {
        // Idempotency: if we already have it (e.g. focus-load raced), skip.
        if (prev.some((t) => t.id === payload.thought.id)) return prev;
        return [payload.thought, ...prev];
      });
    };

    const onUpdated = (payload: { thought: Thought }) => {
      if (!payload?.thought) return;
      if (viewer) ingestStreamCollapsed(viewer, [payload.thought]);
      setThoughts((prev) => prev.map((t) => (t.id === payload.thought.id ? { ...t, ...payload.thought } : t)));
    };

    const onCollapsed = (payload: { thoughtId: string; collapsed: boolean }) => {
      if (viewer && payload?.thoughtId) applyCollapsed(viewer, payload.thoughtId, payload.collapsed === true);
    };

    sock.on('thought:created', onCreated);
    sock.on('thought:updated', onUpdated);
    sock.on('thought:collapsed', onCollapsed);
    return () => {
      sock.off('thought:created', onCreated);
      sock.off('thought:updated', onUpdated);
      sock.off('thought:collapsed', onCollapsed);
    };
  }, [viewer]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteThought(id);
      if (mountedRef.current) {
        setThoughts((prev) => prev.filter((t) => t.id !== id));
      }
    } catch (e) {
      Alert.alert('Error', streamErrorMessage(e, 'Failed to delete Stream entry'));
    }
  }, []);

  // ── Inline editing (NoteStream behavior) ─────────────────────────────────
  const savingNew = useRef(false);
  const draftRevision = useRef(0);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const openAdd = useCallback((text = '') => {
    draftRevision.current += 1;
    setEditingId(null);
    setQuery('');
    setCreating(true);
    setNewDraft(text);
  }, []);

  const startEdit = useCallback((thought: Thought) => {
    draftRevision.current += 1;
    setCreating(false);
    setEditingId(thought.id);
    setEditDraft(thought.text);
  }, []);

  // Commit on blur ("tap away and it just saves").
  const commitNew = useCallback(async () => {
    const text = newDraft.trim();
    if (savingNew.current) return;
    if (!text) { setCreating(false); return; }
    savingNew.current = true;
    const submittedRevision = draftRevision.current;
    try {
      const t = await createThought({ text });
      if (mountedRef.current) setThoughts((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
    } catch (e) {
      Alert.alert('Error', streamErrorMessage(e, 'Failed to save Stream entry'));
      return;
    } finally { savingNew.current = false; }
    if (draftRevision.current === submittedRevision) {
      setCreating(false);
      setNewDraft('');
    }
  }, [newDraft]);

  const commitEdit = useCallback(async () => {
    const id = editingId;
    const text = editDraft.trim();
    setEditingId(null);
    if (!id) return;
    const orig = thoughts.find((t) => t.id === id);
    if (!orig || !text || text === orig.text) return;
    try {
      const updated = await updateThought(id, { text });
      if (mountedRef.current) setThoughts((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
    } catch (e) {
      Alert.alert('Error', streamErrorMessage(e, 'Failed to save Stream entry'));
    }
  }, [editingId, editDraft, thoughts]);

  const renderEditorCard = (value: string, onChange: (text: string) => void, onSave: () => void, placeholder?: string) => (
    <StreamEditor value={value} onChangeText={onChange} onSave={onSave} placeholder={placeholder} />
  );

  // Tapping a tag chip filters the list to that tag.
  const handleTagPress = useCallback((tag: string) => {
    setQuery(tag.replace(/^#/, ''));
  }, []);

  // What the list shows. Vision rows only count when the latest search for
  // this query succeeded; otherwise it is the plain local Stream search.
  const searching = query.trim().length > 0;
  const vision = searching && visionOk;
  const items: StreamItem<Thought>[] = useMemo(() => {
    if (vision && chip === 'all') return mergeStreamItems(visionRows, []);
    if (vision) return mergeStreamItems(visionRows, thoughts);
    return thoughts.map((thought): StreamItem<Thought> => ({ source: 'local', id: thought.id, createdAt: thought.createdAt, thought }));
  }, [vision, chip, visionRows, thoughts]);
  const showChips = searching && availability === 'available';

  // Empty state — distinct copy for "no results for a search" vs "no thoughts yet".
  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyText, { color: c.textMetadata }]}>
          {searching
            ? `No Stream entries match "${query.trim()}".`
            : 'Your Stream is empty. Tap + to add an entry.'}
        </Text>
      </View>
    );
  };

  if (error && thoughts.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
        <TouchableOpacity onPress={() => load(false)} style={styles.retryButton}>
          <Text style={{ color: c.primary }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {/* Search bar — mirrors the SearchScreen pattern for consistency. */}
      <ThoughtsSearchBar
        value={query}
        onChangeText={setQuery}
        onCreate={text => openAdd(text)}
        placeholder="Search or create a Stream entry"
      />
      {showChips && (
        <View style={styles.chipRow} accessibilityRole="radiogroup">
          <Chip label="From OpenChat" selected={chip === 'openchat'} accessibilityRole="radio" onPress={() => selectChip('openchat')} testID="vision-chip-openchat" />
          <Chip label="All my notes" selected={chip === 'all'} accessibilityRole="radio" onPress={() => selectChip('all')} testID="vision-chip-all" />
        </View>
      )}
      {searching && visionNotice && (
        <Text accessibilityRole="alert" testID="vision-unavailable-notice" style={[styles.notice, { color: c.textMetadata }]}>
          {VISION_UNAVAILABLE_NOTICE}
        </Text>
      )}
      <View style={styles.displayRow}>
        <StreamCompactToggle />
      </View>

      <FlatList
        data={items}
        keyExtractor={(entry) => entry.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: entry }) => {
          if (entry.source === 'vision') return <VisionNoteCard row={entry.row} />;
          const item = entry.thought;
          return item.id === editingId ? (
            renderEditorCard(editDraft, setEditDraft, () => void commitEdit())
          ) : (
            <ThoughtCard
              item={item}
              onOpenContext={(item.hasSourceMessage || item.sourceMessageId) ? () => navigation.navigate('OriginalMessage', { thoughtId: item.id }) : undefined}
              onPress={() => startEdit(item)}
              onDelete={() => handleDelete(item.id)}
              onTagPress={handleTagPress}
              subtitle={item.sourceConversationName ? `from ${item.sourceConversationName}` : null}
            />
          );
        }}
        ListFooterComponent={
          vision && visionCursor ? (
            <View style={styles.loadMore}>
              <Button label="Load more" variant="secondary" size="sm" loading={loadingMore} onPress={() => void loadMoreVision()} testID="vision-load-more" />
              {loadMoreFailed && <Text style={[styles.notice, { color: c.textMetadata }]}>Could not load more from Vision.</Text>}
            </View>
          ) : null
        }
        ListHeaderComponent={
          creating ? renderEditorCard(newDraft, text => { draftRevision.current += 1; setNewDraft(text); }, () => void commitNew(), 'New Stream entry…') : null
        }
        keyboardDismissMode="on-drag"
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={c.primary}
          />
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.primary }]}
        onPress={() => openAdd()}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="New Stream entry"
      >
        <AppIcon name="plus" color={c.onPrimary} size={22} strokeWidth={2.2} /><Text style={{ color: c.onPrimary, fontSize: 10 }}>Create</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  displayRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12 },
  chipRow: { flexDirection: 'row', gap: space[2], paddingHorizontal: space[4], paddingTop: space[2] },
  notice: { ...type.meta, paddingHorizontal: space[4], paddingTop: space[2] },
  loadMore: { alignItems: 'center', paddingVertical: space[3], gap: space[2] },
  searchWrap: {
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 88 },
  // Same index-card look as ThoughtCard, in edit mode.
  editorCard: {
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 14,
    marginBottom: 10,
  },
  editorInput: {
    fontSize: 15,
    lineHeight: 22,
    minHeight: 44,
    padding: 0,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retryButton: { padding: 8 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
});
