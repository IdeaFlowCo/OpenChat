/**
 * Links lane of a conversation (OpenChat-c8to.5): every address shared in the
 * chat, kept as one lasting entry. Each has a guessed kind and suggested tags
 * that any member can correct, and a Save mark that is the member's own.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, type ConversationResource, type ResourceKind } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import { filterResources, kindCounts, KIND_LABEL, NO_FILTER, parseTagInput, RESOURCE_KINDS, resourceTitle, sharedLine, type ResourceFilter } from '../utils/conversationResources';
import { openMessageLink } from './MessageText';
import { Button, Card, Chip } from './ui';

const PENDING_REFRESH_MS = 3000;
const PENDING_REFRESHES = 5;

export function ResourcesLane({ conversationId }: { conversationId: string }) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const { currentUser } = useChat();
  const [resources, setResources] = useState<ConversationResource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [indexingPending, setIndexingPending] = useState(false);
  const [filter, setFilter] = useState<ResourceFilter>(NO_FILTER);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);
  const refreshes = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) { setLoading(true); refreshes.current = 0; }
    try {
      const result = await api.listConversationResources(conversationId);
      if (!alive.current) return;
      setResources(current => quiet && current ? [...result.resources, ...current.filter(item => !result.resources.some(fresh => fresh.id === item.id))] : result.resources);
      if (!quiet) setNextCursor(result.nextCursor ?? null);
      setError(null); setIndexingPending(result.indexingPending === true);
      // Page titles arrive a moment after a link is first collected.
      if (result.indexingPending || (result.pending > 0 && refreshes.current < PENDING_REFRESHES)) {
        refreshes.current += 1;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(true), PENDING_REFRESH_MS);
      }
    } catch (e) {
      if (alive.current && !quiet) setError(e instanceof Error && e.message ? e.message : 'Could not load links.');
    } finally { if (alive.current && !quiet) setLoading(false); }
  }, [conversationId]);

  useEffect(() => {
    alive.current = true;
    setResources(null); setFilter(NO_FILTER); setEditingId(null); setNotice(null);
    void load();
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.listConversationResources(conversationId, nextCursor);
      if (!alive.current) return;
      setResources(current => [...(current ?? []), ...result.resources.filter(item => !current?.some(existing => existing.id === item.id))]);
      setNextCursor(result.nextCursor ?? null); setError(null);
    } catch { if (alive.current) setNotice({ text: 'Could not load more links. Try again.', error: true }); }
    finally { if (alive.current) setLoadingMore(false); }
  }, [conversationId, nextCursor, loadingMore]);

  const replace = useCallback((next: ConversationResource) => setResources(current => current ? current.map(item => item.id === next.id ? next : item) : current), []);
  const toggleSaved = useCallback(async (resource: ConversationResource) => {
    const saved = !resource.saved;
    // Show the change at once; put it back if the server refuses.
    replace({ ...resource, saved, savedCount: Math.max(0, resource.savedCount + (saved ? 1 : -1)) });
    try { replace((await api.setConversationResourceSaved(conversationId, resource.id, saved)).resource); setNotice(null); }
    catch { replace(resource); setNotice({ text: 'Could not update Saved. Try again.', error: true }); }
  }, [conversationId, replace]);

  const visible = useMemo(() => filterResources(resources ?? [], filter), [resources, filter]);
  const kinds = useMemo(() => kindCounts(resources ?? []), [resources]);
  const savedCount = useMemo(() => (resources ?? []).filter(resource => resource.saved).length, [resources]);
  const filtering = filter.saved || !!filter.kind || !!filter.tag || !!filter.query.trim();

  if (!resources) {
    return (
      <View style={styles.center}>
        {error
          ? <><Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>{error}</Text><Button label="Try again" size="sm" onPress={() => void load()} /></>
          : <ActivityIndicator color={r.accent} accessibilityLabel="Loading links" />}
      </View>
    );
  }

  return (
    <View style={styles.container} testID="resources-lane">
      <View style={[styles.toolbar, { borderBottomColor: r.line }]}>
        <TextInput
          accessibilityLabel="Search links"
          placeholder="Search links and tags"
          placeholderTextColor={r.decoration}
          value={filter.query}
          onChangeText={query => setFilter(current => ({ ...current, query }))}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.search, type.body, { color: r.text, backgroundColor: r.input, borderColor: r.line }]}
        />
        <Button label="Refresh" size="sm" variant="ghost" loading={loading} onPress={() => void load()} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={styles.filters} accessibilityRole="toolbar" accessibilityLabel="Filter links">
        <Chip label={`All ${resources.length}`} selected={!filter.saved && !filter.kind && !filter.tag} onPress={() => setFilter(current => ({ ...NO_FILTER, query: current.query }))} testID="resources-filter-all" />
        <Chip label={`Saved ${savedCount}`} selected={filter.saved} onPress={() => setFilter(current => ({ ...current, saved: !current.saved }))} testID="resources-filter-saved" />
        {kinds.map(({ kind, count }) => (
          <Chip key={kind} label={`${KIND_LABEL[kind]} ${count}`} selected={filter.kind === kind} onPress={() => setFilter(current => ({ ...current, kind: current.kind === kind ? null : kind }))} />
        ))}
        {filter.tag ? <Chip label={`#${filter.tag} ×`} selected accessibilityLabel={`Clear tag filter ${filter.tag}`} onPress={() => setFilter(current => ({ ...current, tag: null }))} /> : null}
      </ScrollView>
      {indexingPending ? <Text accessibilityLiveRegion="polite" style={[type.meta, styles.notice, { color: r.textMeta }]}>Older links are still being collected.</Text> : null}
      {notice ? <Text accessibilityRole={notice.error ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[type.meta, styles.notice, { color: notice.error ? r.danger : r.textMeta }]}>{notice.text}</Text> : null}
      <FlatList
        data={visible}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <ResourceCard
            resource={item}
            viewerUserId={currentUser?.userId}
            editing={editingId === item.id}
            onEdit={() => { setEditingId(item.id); setNotice(null); }}
            onCancel={() => setEditingId(null)}
            onSaved={next => { replace(next); setEditingId(null); setNotice({ text: 'Tags updated for everyone in this chat.', error: false }); }}
            onToggleSaved={() => void toggleSaved(item)}
            onTagPress={tag => setFilter(current => ({ ...current, tag }))}
            conversationId={conversationId}
          />
        )}
        ListFooterComponent={nextCursor ? <Button label="Load more links" size="sm" loading={loadingMore} onPress={() => void loadMore()} /> : null}
        ListEmptyComponent={
          <Text style={[type.body, styles.empty, { color: r.textMeta }]}>
            {filtering ? 'No links match.' : 'Links shared in this chat are kept here, with tags you can edit and a Save mark of your own.'}
          </Text>
        }
      />
    </View>
  );
}

function ResourceCard({ resource, viewerUserId, editing, onEdit, onCancel, onSaved, onToggleSaved, onTagPress, conversationId }: {
  resource: ConversationResource; viewerUserId?: string; editing: boolean; conversationId: string;
  onEdit: () => void; onCancel: () => void; onSaved: (next: ConversationResource) => void; onToggleSaved: () => void; onTagPress: (tag: string) => void;
}) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const title = resourceTitle(resource);
  const webLink = Platform.OS === 'web' ? { href: resource.url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {};
  return (
    <Card style={styles.card} testID={`resource-${resource.id}`}>
      <View style={styles.head}>
        <Text style={[type.eyebrow, { color: r.textMeta }]}>{KIND_LABEL[resource.kind]}{resource.kindEdited ? '' : ' · suggested'}</Text>
        <Button
          label={resource.saved ? 'Saved' : 'Save'}
          size="sm"
          variant={resource.saved ? 'secondary' : 'ghost'}
          icon={resource.saved ? 'check' : undefined}
          accessibilityLabel={resource.saved ? `Saved. Remove ${title} from your saved links` : `Save ${title}`}
          onPress={onToggleSaved}
          testID={`resource-save-${resource.id}`}
        />
      </View>
      <Text {...webLink} accessibilityRole="link" style={[type.bodyStrong, { color: r.text }]} numberOfLines={2}
        onPress={Platform.OS === 'web' ? undefined : () => void openMessageLink(resource.url)}>{title}</Text>
      <Text style={[type.meta, { color: r.textMeta }]} numberOfLines={1}>{resource.host}{resource.savedCount > 0 ? ` · Saved by ${resource.savedCount}` : ''}</Text>
      {resource.description ? <Text style={[type.body, { color: r.textSecondary }]} numberOfLines={2}>{resource.description}</Text> : null}
      <Text style={[type.meta, { color: r.textMeta }]} numberOfLines={1}>{sharedLine(resource, viewerUserId)}</Text>
      {editing
        ? <ResourceEditor resource={resource} conversationId={conversationId} onCancel={onCancel} onSaved={onSaved} />
        : <View style={styles.tags}>
            {resource.tags.map(tag => <Chip key={tag} label={`#${tag}`} onPress={() => onTagPress(tag)} accessibilityLabel={`Show links tagged ${tag}`} />)}
            <Button label={resource.tags.length ? 'Edit tags' : 'Add tags'} size="sm" variant="ghost" icon="edit" onPress={onEdit} testID={`resource-edit-${resource.id}`} />
            {!resource.tagsEdited && resource.tags.length ? <Text style={[type.meta, { color: r.textMeta }]}>Suggested</Text> : null}
          </View>}
    </Card>
  );
}

function ResourceEditor({ resource, conversationId, onCancel, onSaved }: { resource: ConversationResource; conversationId: string; onCancel: () => void; onSaved: (next: ConversationResource) => void }) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const [text, setText] = useState(resource.tags.join(', '));
  const [kind, setKind] = useState<ResourceKind>(resource.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const change: { tags: string[]; kind?: ResourceKind } = { tags: parseTagInput(text) };
      if (kind !== resource.kind) change.kind = kind;
      onSaved((await api.updateConversationResource(conversationId, resource.id, change)).resource);
    } catch (e) { setError(e instanceof Error && e.message ? e.message : 'Could not save. Try again.'); setBusy(false); }
  };
  return (
    <View style={styles.editor}>
      <Text style={[type.label, { color: r.textSecondary }]}>Tags, separated by commas</Text>
      <TextInput
        accessibilityLabel="Tags"
        value={text}
        onChangeText={setText}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => void save()}
        placeholder="research, hci"
        placeholderTextColor={r.decoration}
        style={[styles.input, type.body, { color: r.text, backgroundColor: r.input, borderColor: r.line }]}
        testID={`resource-tags-input-${resource.id}`}
      />
      <Text style={[type.label, { color: r.textSecondary }]}>Kind</Text>
      <View style={styles.tags} accessibilityRole="radiogroup" accessibilityLabel="Kind">
        {RESOURCE_KINDS.map(value => <Chip key={value} label={KIND_LABEL[value]} selected={kind === value} accessibilityRole="radio" onPress={() => setKind(value)} />)}
      </View>
      {error ? <Text accessibilityRole="alert" style={[type.meta, { color: r.danger }]}>{error}</Text> : null}
      <View style={styles.editorActions}>
        <Button label="Save tags" size="sm" variant="primary" loading={busy} onPress={() => void save()} testID={`resource-tags-save-${resource.id}`} />
        <Button label="Cancel" size="sm" variant="ghost" disabled={busy} onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[3], padding: space[6] },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2], borderBottomWidth: StyleSheet.hairlineWidth },
  search: { flex: 1, minWidth: 0, height: touchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space[3] },
  // A horizontal ScrollView collapses to nothing on web unless it is told not to shrink.
  filterRow: { flexGrow: 0, flexShrink: 0 },
  filters: { gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2], alignItems: 'center', minHeight: touchTarget + space[2] },
  notice: { paddingHorizontal: space[4], paddingBottom: space[1] },
  list: { padding: space[3], paddingBottom: space[6], gap: space[2] },
  card: { gap: space[1] },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  tags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2], marginTop: space[1] },
  editor: { gap: space[2], marginTop: space[2] },
  input: { height: touchTarget, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space[3] },
  editorActions: { flexDirection: 'row', gap: space[2] },
  empty: { textAlign: 'center', margin: space[6] },
});
