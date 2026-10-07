import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, TextInput, AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { contextLaneManager } from '../services/contextLane';
import { api, ContextPost } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { ContextComposer } from './ContextComposer';

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
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser } = useChat();
  const [state, setState] = useState<ReturnType<typeof contextLaneManager.getState>>({ posts: [], hasMore: true, isLoading: true, isError: false, search: '' });
  const [search, setSearch] = useState('');
  const [replyTo, setReplyTo] = useState<ContextPost>();
  const [editing, setEditing] = useState<ContextPost>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [reporting, setReporting] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean }>();

  useEffect(() => {
    contextLaneManager.setAccount(currentUser?.userId ?? null);
    return contextLaneManager.subscribe(conversationId, setState);
  }, [conversationId, currentUser?.userId]);
  useFocusEffect(useCallback(() => {
    const refresh = () => { if (AppState.currentState === 'active') void contextLaneManager.loadInitial(conversationId); };
    void contextLaneManager.loadInitial(conversationId);
    const timer = setInterval(refresh, 30_000);
    const subscription = AppState.addEventListener('change', status => { if (status === 'active') refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [conversationId]));
  useEffect(() => {
    const timer = setTimeout(() => { if (search.trim() !== contextLaneManager.getState(conversationId).search) void contextLaneManager.loadInitial(conversationId, search.trim()); }, 300);
    return () => clearTimeout(timer);
  }, [search, conversationId]);

  const action = async (id: string, fn: () => Promise<unknown>, success?: string) => {
    if (busy) return;
    setBusy(id); setFeedback(undefined);
    try { await fn(); if (success) setFeedback({ text: success, error: false }); setConfirmDelete(undefined); setReporting(undefined); }
    catch (e) { setFeedback({ text: e instanceof Error ? e.message : 'Could not complete this action. Try again.', error: true }); }
    finally { setBusy(undefined); }
  };
  const button = (label: string, onPress: () => void, danger = false) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={!!busy} onPress={onPress} style={styles.action}><Text style={{ color: danger ? c.danger : c.primary, fontWeight: '500' }}>{label}</Text></TouchableOpacity>;
  const renderItem = ({ item: { post: item, reply } }: { item: { post: ContextPost; reply: boolean } }) => {
    const own = item.authorId === currentUser?.userId;
    const parent = item.replyTo || state.posts.find(p => p.id === item.replyToId);
    return <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, marginLeft: reply ? 16 : 0 }]}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
        <Text style={{ color: c.textPrimary, fontWeight: '600' }}>{item.author?.name || (own ? 'You' : 'Chat participant')}</Text>
        {item.agent && <Text style={{ color: c.textMetadata, fontSize: 12 }}>via {item.agent.name} · Agent</Text>}
        <Text style={{ color: c.textMetadata, fontSize: 12 }}>{item.kind === 'ask' ? 'Ask' : item.kind === 'offer' ? 'Offer' : 'Note'}</Text>
      </View>
      <Text style={{ color: c.textMetadata, fontSize: 12, marginTop: 3 }}>{new Date(item.createdAt).toLocaleString()}{item.revision > 1 ? ' · Edited' : ''}</Text>
      {item.replyToId && <View style={[styles.quote, { borderLeftColor: c.border }]}><Text numberOfLines={2} style={{ color: c.textMetadata, fontSize: 13 }}>{parent?.isDeleted ? 'Reply to a deleted post' : parent ? `Reply to ${parent.author?.name || 'a participant'}: ${parent.text}` : 'Reply to an earlier post'}</Text></View>}
      <Text selectable style={{ color: item.isDeleted ? c.textMetadata : c.textPrimary, fontSize: 15, lineHeight: 22, marginTop: 8 }}>{item.isDeleted ? 'Post deleted' : item.text}</Text>
      {!item.isDeleted && <View style={styles.actions}>
        {button('Reply', () => { setReplyTo(item); setEditing(undefined); })}
        {own && button('Edit', () => { setEditing(item); setReplyTo(undefined); })}
        {own && button('Delete', () => setConfirmDelete(item.id), true)}
        {!own && button('Report', () => setReporting(item.id))}
        {item.kind === 'ask' && button('Ask agents', () => void action(item.id, async () => {
          const result = await api.askContextAgents(conversationId, item.id);
          setFeedback({ text: `Requested help from ${result.queued} agent${result.queued === 1 ? '' : 's'}. Replies will appear here.`, error: false });
        }))}
      </View>}
      {confirmDelete === item.id && <View><Text style={{ color: c.textMetadata }}>Delete this post? Replies will remain.</Text><View style={styles.actions}>{button('Confirm delete', () => void action(item.id, () => contextLaneManager.deletePost(conversationId, item.id)), true)}{button('Cancel', () => setConfirmDelete(undefined))}</View></View>}
      {reporting === item.id && <View><Text style={{ color: c.textMetadata }}>Report this post for review</Text><View style={styles.actions}>{['Spam', 'Harassment', 'Other'].map(reason => <React.Fragment key={reason}>{button(reason, () => void action(item.id, () => api.reportContextPost(conversationId, item.id, reason.toLowerCase()), 'Report submitted.'))}</React.Fragment>)}{button('Cancel', () => setReporting(undefined))}</View></View>}
      {busy === item.id && <ActivityIndicator color={c.primary} accessibilityLabel="Working" />}
    </View>;
  };
  return <View style={styles.container}>
    <View style={[styles.toolbar, { borderBottomColor: c.border }]}>
      <TextInput accessibilityLabel="Search context" placeholder="Search context" placeholderTextColor={c.textMuted} value={search} onChangeText={setSearch} style={[styles.search, { color: c.textPrimary, backgroundColor: c.surface, borderColor: c.border }]} />
      {button('Refresh', () => void contextLaneManager.loadInitial(conversationId))}
    </View>
    {feedback && <Text accessibilityRole={feedback.error ? 'alert' : undefined} accessibilityLiveRegion="polite" style={{ color: feedback.error ? c.danger : c.textMetadata, padding: 12 }}>{feedback.text}</Text>}
    {state.isError && <View style={{ paddingHorizontal: 16 }}><Text accessibilityRole="alert" style={{ color: c.danger }}>Could not refresh Context. {state.posts.length ? 'Showing previously loaded posts.' : ''}</Text>{button('Retry', () => void contextLaneManager.loadInitial(conversationId))}</View>}
    <FlatList data={contextThreads(state.posts)} keyExtractor={row => row.post.id} renderItem={renderItem}
      contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
      refreshing={state.isLoading} onRefresh={() => void contextLaneManager.loadInitial(conversationId)}
      onEndReached={() => { if (!state.isError) void contextLaneManager.loadMore(conversationId); }} onEndReachedThreshold={0.5}
      ListFooterComponent={state.hasMore && state.posts.length ? button('Load older posts', () => void contextLaneManager.loadMore(conversationId)) : null}
      ListEmptyComponent={state.isLoading ? <ActivityIndicator color={c.primary} style={{ margin: 24 }} /> : !state.isError ? <Text style={{ color: c.textMetadata, textAlign: 'center', margin: 24 }}>{search ? 'No matching context posts.' : 'A quiet back-channel for this chat. Add a note, ask a question, or share an offer.'}</Text> : null} />
    <ContextComposer key={`${conversationId}:${editing?.id || replyTo?.id || 'new'}`} conversationId={conversationId} editing={editing} replyTo={replyTo} onDone={() => { setEditing(undefined); setReplyTo(undefined); void contextLaneManager.loadInitial(conversationId); }} />
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { flex: 1, minWidth: 0, height: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, marginVertical: 8 },
  card: { padding: 12, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, marginBottom: 10 },
  quote: { borderLeftWidth: 2, paddingLeft: 10, marginTop: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
