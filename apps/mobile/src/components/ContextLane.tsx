import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, TextInput, AppState, Pressable } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { contextLaneManager } from '../services/contextLane';
import { api, ContextPost } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { ContextComposer } from './ContextComposer';
import { ContextStreamEntry, ConversationEntryEditor } from './ContextStreamEntry';
import { StreamCompactToggle } from './StreamCompactToggle';
import { applyCollapsed } from '../services/streamDisplay';
import { useConversationContent } from '../services/useConversationContent';
import { getSocket } from '../api/socket';
import { type, radius, space } from '../theme/tokens';
import { ContextIntentionControls } from './ContextIntentionControls';
import { StreamText } from './StreamText';
import { sharedScopeLabel } from '../utils/streamScope';
import { StreamCardHeader } from './StreamCardHeader';
import { AppIcon } from './AppIcon';
import { Chip } from './ui';
import { AgentMarkdown } from './AgentMarkdown';

/** Group loaded replies below their root, while retaining orphan previews across pages. */
export function contextThreads(posts: ContextPost[]): { post: ContextPost; reply: boolean }[] {
  const byId = new Map(posts.map(p => [p.id, p]));
  const root = (p: ContextPost) => {
    const seen = new Set([p.id]);
    while (p.replyToId && byId.has(p.replyToId) && !seen.has(p.replyToId)) { seen.add(p.replyToId); p = byId.get(p.replyToId)!; }
    return p.id;
  };
  const groups = new Map<string, ContextPost[]>();
  posts.forEach(p => { const id = root(p); groups.set(id, [...(groups.get(id) || []), p]); });
  return [...groups].flatMap(([id, group]) => {
    const parent = byId.get(id)!;
    return [{ post: parent, reply: !!parent.replyToId }, ...group.filter(p => p.id !== id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(post => ({ post, reply: true }))];
  });
}

export function ContextLane({ conversationId }: { conversationId: string }) {
  const { currentUser } = useChat();
  return currentUser ? <ConversationContentSession key={`${currentUser.userId}:${conversationId}`} accountId={currentUser.userId} conversationId={conversationId} /> : null;
}
function ConversationContentSession({ conversationId, accountId }: { conversationId: string; accountId: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser, conversations } = useChat();
  const conversation = conversations?.find(item => item.id === conversationId);
  const announcementReadOnly = conversation?.communityKind === 'announcements' && conversation.canPost !== true;
  // The scope label names who the chat is with, from its membership; "this chat" when that is unknown.
  const sharedScope = sharedScopeLabel(conversations?.find(conversation => conversation.id === conversationId), currentUser?.userId);
  const [quoteOpen, setQuoteOpen] = useState<string>();
  const feed = useConversationContent(accountId, conversationId);
  const search = feed.search;
  const state = { posts: feed.items.flatMap(item => item.origin === 'context' ? [item.context] : []), isLoading: feed.loading, isError: !!feed.error, hasMore: feed.hasMore };
  const [creatingPrivate, setCreatingPrivate] = useState(false);
  const [replyTo, setReplyTo] = useState<ContextPost>();
  const [editing, setEditing] = useState<ContextPost>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [reporting, setReporting] = useState<string>();
  const [actionsFor, setActionsFor] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean }>();

  useEffect(() => { contextLaneManager.setAccount(accountId); }, [accountId]);
  useEffect(() => { if (feed.contextAvailable === false) { setEditing(undefined); setReplyTo(undefined); setConfirmDelete(undefined); setReporting(undefined); } }, [feed.contextAvailable]);
  const load = feed.load;
  useFocusEffect(useCallback(() => {
    const refresh = () => { if (AppState.currentState === 'active') void load(); };
    void load(); const timer = setInterval(refresh, 30_000);
    const subscription = AppState.addEventListener('change', status => { if (status === 'active') refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [load]));

  useEffect(() => {
    const socket = getSocket();
    const refresh = () => void load();
    const events = ['thought:created', 'thought:shared', 'thought:unshared', 'thought:pinned', 'thought:unpinned', 'thought:updated'];
    const onCollapsed = (payload: { thoughtId: string; collapsed: boolean }) => { if (payload?.thoughtId) applyCollapsed(accountId, payload.thoughtId, payload.collapsed === true); };
    events.forEach(event => socket?.on(event, refresh));
    socket?.on('thought:collapsed', onCollapsed);
    return () => { events.forEach(event => socket?.off(event, refresh)); socket?.off('thought:collapsed', onCollapsed); };
  }, [load, accountId]);

  const action = async (id: string, fn: () => Promise<unknown>, success?: string) => {
    if (busy) return;
    setBusy(id); setFeedback(undefined);
    try { await fn(); void load(); if (success) setFeedback({ text: success, error: false }); setConfirmDelete(undefined); setReporting(undefined); }
    catch (e) { setFeedback({ text: e instanceof Error ? e.message : 'Could not complete this action. Try again.', error: true }); }
    finally { setBusy(undefined); }
  };
  const button = (label: string, onPress: () => void, danger = false) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={!!busy} onPress={onPress} style={styles.action}><Text style={{ color: danger ? c.danger : c.primary, fontWeight: '500' }}>{label}</Text></TouchableOpacity>;
  const renderItem = ({ item: { post: item, reply } }: { item: { post: ContextPost; reply: boolean } }) => {
    const own = item.authorId === currentUser?.userId;
    const parent = item.replyTo || state.posts.find(p => p.id === item.replyToId);
    return <Pressable accessible={false} focusable={false} onHoverIn={() => setActionsFor(item.id)} onLongPress={() => setActionsFor(item.id)} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, marginLeft: reply ? 16 : 0 }]}>
      <StreamCardHeader name={item.author?.name || (own ? 'You' : 'Chat participant')} avatarUrl={item.author?.avatarUrl} agentName={item.agent?.name}
        createdAt={item.createdAt} edited={item.revision > 1} audience="shared" sharedScope={sharedScope} kind={item.kind === 'ask' ? 'Ask' : item.kind === 'offer' ? 'Offer' : 'Note'}
        onShowExactTime={text => setFeedback({ text, error: false })}
        trailing={item.isDeleted ? null : <TouchableOpacity accessibilityRole="button" accessibilityLabel={actionsFor === item.id ? 'Hide actions' : 'More'} accessibilityState={{ expanded: actionsFor === item.id }} disabled={!!busy} hitSlop={14}
          onPress={() => setActionsFor(actionsFor === item.id ? undefined : item.id)}><Text style={[type.label, { color: c.primary }]}>{actionsFor === item.id ? 'Hide actions' : 'More'}</Text></TouchableOpacity>} />
      {item.replyToId && <Pressable accessibilityRole="button" accessibilityLabel={quoteOpen === item.id ? 'Collapse quoted post' : 'Expand quoted post'} accessibilityState={{ expanded: quoteOpen === item.id }}
        onPress={() => setQuoteOpen(quoteOpen === item.id ? undefined : item.id)} style={[styles.quote, { borderLeftColor: c.border }]}>
        <Text numberOfLines={quoteOpen === item.id ? undefined : 1} style={{ color: c.textMetadata, ...type.label }}>{parent?.isDeleted ? 'Reply to a deleted post' : parent ? `Reply to ${parent.author?.name || 'a participant'}: ${parent.text}` : 'Reply to an earlier post'}</Text>
      </Pressable>}
      {item.isDeleted ? <Text style={{ color: c.textMetadata, ...type.body, marginTop: 6 }}>Post deleted</Text>
        // An agent's post is Markdown, as in chat; a person's post keeps its exact characters. Links open in both.
        : item.agent ? <View style={{ marginTop: 6 }}><AgentMarkdown content={item.text} color={c.textPrimary} linkColor={c.primary} codeBackground={c.surfaceElevated} selectable onLongPress={() => setActionsFor(item.id)} /></View>
        : <StreamText content={item.text} color={c.textPrimary} linkColor={c.primary} pathBackground={c.surfaceElevated} style={{ marginTop: 6 }} onLongPress={() => setActionsFor(item.id)} />}
      {!item.isDeleted && actionsFor === item.id && <View style={styles.actions}>
        {!announcementReadOnly && button('Reply', () => { setReplyTo(item); setEditing(undefined); })}
        {!announcementReadOnly && own && button('Edit', () => { setEditing(item); setReplyTo(undefined); })}
        {!announcementReadOnly && own && button('Delete', () => setConfirmDelete(item.id), true)}
        {!own && button('Report', () => setReporting(item.id))}
        {!announcementReadOnly && item.kind === 'ask' && (!item.intention || item.intention.lifecycleState === 'open') && button('Ask agents', () => void action(item.id, async () => {
          const result = await api.askContextAgents(conversationId, item.id);
          setFeedback({ text: result.queued ? `Requested help from ${result.queued} agent${result.queued === 1 ? '' : 's'}. Replies will appear here.` : 'These agents have already received this request. Replies will appear here.', error: false });
        }))}
      </View>}
      {!announcementReadOnly && !item.isDeleted && actionsFor === item.id && <ContextIntentionControls post={item} conversationId={conversationId} onChange={() => void load()} />}
      {!announcementReadOnly && confirmDelete === item.id && <View><Text style={{ color: c.textMetadata }}>Delete this post? Replies will remain.</Text><View style={styles.actions}>{button('Confirm delete', () => void action(item.id, () => contextLaneManager.deletePost(conversationId, item.id)), true)}{button('Cancel', () => setConfirmDelete(undefined))}</View></View>}
      {reporting === item.id && <View><Text style={{ color: c.textMetadata }}>Report this post for review</Text><View style={styles.actions}>{['Spam', 'Harassment', 'Other'].map(reason => <React.Fragment key={reason}>{button(reason, () => void action(item.id, () => api.reportContextPost(conversationId, item.id, reason.toLowerCase()), 'Report submitted.'))}</React.Fragment>)}{button('Cancel', () => setReporting(undefined))}</View></View>}
      {busy === item.id && <ActivityIndicator color={c.primary} accessibilityLabel="Working" />}
    </Pressable>;
  };
  return <View style={styles.container}>
    <View style={styles.toolbar}>
      <View style={[styles.search, { backgroundColor: c.surface, borderColor: c.border }]}>
        <AppIcon name="search" color={c.textMuted} size={16} />
        <TextInput accessibilityLabel="Search conversation content" placeholder="Search this chat’s Stream" placeholderTextColor={c.textMuted} value={search} onChangeText={feed.chooseSearch} style={[type.body, styles.searchInput, { color: c.textPrimary }]} />
        {search ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={14} onPress={() => feed.chooseSearch('')}><Text style={[type.label, { color: c.primary }]}>Clear search</Text></TouchableOpacity> : null}
      </View>
      <View style={styles.filters}>
        {(feed.contextAvailable === false ? ['stream'] as const : ['all', 'context', 'stream'] as const).map(filter => <Chip key={filter}
          label={filter === 'all' ? 'All' : filter === 'context' ? 'Back channel' : 'Saved'}
          accessibilityLabel={filter === 'all' ? 'All content' : filter === 'context' ? 'Back channel posts' : 'Stream entries'}
          selected={feed.contextAvailable === false || feed.filter === filter} onPress={() => feed.chooseFilter(filter)} />)}
        <StreamCompactToggle />
        <Chip icon="lock" label="Private entry" onPress={() => setCreatingPrivate(true)} />
      </View>
    </View>
    {feed.contextAvailable === false && <Text style={{ color: c.textMetadata, paddingHorizontal: 16 }}>Back channel is unavailable. This chat’s Stream and your private entries remain available.</Text>}
    {creatingPrivate && <ConversationEntryEditor conversationId={conversationId} onCancel={() => setCreatingPrivate(false)} onDone={() => { setCreatingPrivate(false); void load(); }} />}
    {feedback && <Text accessibilityRole={feedback.error ? 'alert' : undefined} accessibilityLiveRegion="polite" style={{ color: feedback.error ? c.danger : c.textMetadata, padding: 12 }}>{feedback.text}</Text>}
    {state.isError && <View style={{ paddingHorizontal: 16 }}><Text accessibilityRole="alert" style={{ color: c.danger }}>{feed.error} {feed.items.length ? 'Showing previously loaded content.' : ''}</Text>{button('Retry', () => void load())}</View>}
    <FlatList data={feed.items} keyExtractor={item => item.id} renderItem={({ item }) => item.origin === 'context' ? renderItem({ item: { post: item.context, reply: !!item.context.replyToId } }) : <ContextStreamEntry item={item} conversationId={conversationId} sharedScope={sharedScope} announcementReadOnly={announcementReadOnly} onChange={() => void load()} onTagPress={tag => feed.chooseSearch(tag.replace(/^#/, ''))} />}
      contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
      refreshing={state.isLoading} onRefresh={() => void load()}
      onEndReached={() => { if (!state.isError) void load(true); }} onEndReachedThreshold={0.5}
      ListFooterComponent={state.hasMore && feed.items.length ? button('Load older content', () => void load(true)) : null}
      ListEmptyComponent={state.isLoading ? <ActivityIndicator color={c.primary} style={{ margin: 24 }} /> : !state.isError ? <Text style={{ color: c.textMetadata, textAlign: 'center', margin: 24 }}>{search ? 'No matching conversation content.' : feed.contextAvailable === false ? 'This chat’s Stream entries appear here. Private entries are labeled Only you.' : 'Notes and saved items for this chat appear here. Private entries are labeled Only you.'}</Text> : null} />
    {announcementReadOnly && <Text style={[type.body, { color: c.textMetadata, padding: space[3] }]}>Only community admins can contribute to announcements. Private entries are only for you.</Text>}
    {!announcementReadOnly && feed.contextAvailable === true && <ContextComposer key={`${conversationId}:${editing?.id || replyTo?.id || 'new'}`} conversationId={conversationId} editing={editing} replyTo={replyTo} onDone={() => { setEditing(undefined); setReplyTo(undefined); void load(); }} />}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center' },
  toolbar: { paddingHorizontal: space[3], paddingTop: space[3], gap: space[2] },
  search: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space[3] },
  searchInput: { flex: 1, minWidth: 0, minHeight: 40, paddingVertical: 0 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  card: { paddingHorizontal: space[3], paddingVertical: space[2] + 2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8 },
  quote: { borderLeftWidth: 2, paddingLeft: 8, marginTop: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
