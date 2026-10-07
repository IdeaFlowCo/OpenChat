import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { ContextDraftCard } from '../components/ContextDraftCard';
import { useHostedContextReview } from '../services/useHostedContextReview';

export function ContextReviewScreen() {
  const { currentUser } = useChat();
  // Replacing the entire local session prevents even a one-frame old-account preview.
  return currentUser ? <ContextReviewSession key={currentUser.userId} accountId={currentUser.userId} /> : null;
}
export function ContextReviewSession({ accountId }: { accountId: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const review = useHostedContextReview(accountId);
  const [editingIds, setEditingIds] = useState<Set<string>>(() => new Set());
  const editingRef = useRef(false);
  editingRef.current = editingIds.size > 0;
  useEffect(() => {
    setEditingIds(previous => {
      const remaining = new Set([...previous].filter(id => review.requests.some(request => request.id === id)));
      return remaining.size === previous.size ? previous : remaining;
    });
  }, [review.requests]);
  const load = review.load;
  useFocusEffect(useCallback(() => {
    if (!editingRef.current) void load();
    const timer = setInterval(() => { if (!editingRef.current && AppState.currentState === 'active') void load(); }, 20_000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active' && !editingRef.current) void load(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [load]));
  const header = <View>
    <Text style={[styles.title, { color: c.textPrimary }]}>Agent drafts</Text>
    <Text style={[styles.detail, { color: c.textMetadata }]}>Your private inbox for Context replies. Review the exact reply, its sources, and who will see it before publishing.</Text>
    <View style={[styles.preference, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[styles.label, { color: c.textPrimary }]}>Hosted Context agent</Text>
      <Text style={[styles.detail, { color: c.textMetadata }]}>Off by default. When enabled, explicit Ask agents requests prepare drafts privately. Anthropic processes the shared question and any private text you explicitly add. Generation cannot publish or send messages.</Text>
      <Text style={[styles.detail, { color: c.textMetadata }]}>While enabled, this hosted agent handles your Context requests instead of your opted-in API-key agents. Turning off cancels pending requests and clears unpublished drafts.</Text>
      {review.preferences && <TouchableOpacity accessibilityRole="switch" accessibilityLabel="Hosted Context agent" {...(Platform.OS === 'web' ? { 'aria-checked': review.preferences.enabled } : {})} accessibilityState={{ checked: review.preferences.enabled, disabled: !!review.busy || (!review.preferences.available && !review.preferences.enabled) }}
        disabled={!!review.busy || (!review.preferences.available && !review.preferences.enabled)} onPress={() => void review.toggle()} style={[styles.button, { borderColor: c.border }]}>
        <Text style={{ color: c.primary, fontWeight: '600' }}>{review.busy === 'preferences' ? 'Saving…' : review.preferences.enabled ? 'On · Turn off' : 'Off · Turn on'}</Text>
      </TouchableOpacity>}
      {review.preferences?.available === false && <Text style={[styles.detail, { color: c.textMetadata }]}>Hosted draft generation is currently unavailable.</Text>}
    </View>
    <View style={styles.toolbar}>
      <Text style={[styles.label, { color: c.textPrimary }]}>Private requests</Text>
      <TouchableOpacity accessibilityRole="button" disabled={!!review.busy || editingIds.size > 0} onPress={() => void review.load()} style={styles.refresh}><Text style={{ color: c.primary }}>{review.loading ? 'Refreshing…' : 'Refresh'}</Text></TouchableOpacity>
    </View>
    {review.error ? <View><Text accessibilityRole="alert" style={[styles.detail, { color: c.danger }]}>{review.error}</Text><TouchableOpacity accessibilityRole="button" onPress={() => void review.load()} style={styles.refresh}><Text style={{ color: c.primary }}>Retry loading drafts</Text></TouchableOpacity></View> : null}
    {review.message ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: c.textMetadata }]}>{review.message}</Text> : null}
  </View>;
  return <View style={[styles.root, { backgroundColor: c.background }]}>
    <FlatList data={review.requests} keyExtractor={item => item.id} contentContainerStyle={styles.content}
      ListHeaderComponent={header} keyboardShouldPersistTaps="handled"
      refreshing={review.loading} onRefresh={() => { if (editingIds.size === 0) void review.load(); }}
      renderItem={({ item }) => <ContextDraftCard request={item} enabled={!!review.preferences?.enabled && !!review.preferences?.available}
        busy={!!review.busy} error={review.errors[item.id]} blocked={!!review.blocked[item.id]}
        onAction={(action, input) => review.act(item, action, input)} onEditingChange={editing => setEditingIds(previous => { const next = new Set(previous); if (editing) next.add(item.id); else next.delete(item.id); return next; })} />}
      ListEmptyComponent={review.loading ? <ActivityIndicator accessibilityLabel="Loading private drafts" color={c.primary} style={{ marginTop: 24 }} /> : <Text style={[styles.empty, { color: c.textMetadata }]}>{review.error ? 'Drafts could not be loaded.' : review.preferences?.enabled ? 'No private requests yet. Use Ask agents on a Context post to prepare a reply for review here.' : 'Enable the hosted agent to receive private drafts from Context requests.'}</Text>} />
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 16, paddingBottom: 40 },
  title: { fontSize: 24, lineHeight: 31, fontWeight: '600' },
  label: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 14, lineHeight: 22, marginTop: 8 },
  preference: { padding: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, marginTop: 18 },
  button: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginTop: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 8 },
  refresh: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, alignSelf: 'flex-start' },
  notice: { fontSize: 14, lineHeight: 21, marginBottom: 14 },
  empty: { fontSize: 14, lineHeight: 22, paddingVertical: 24 },
});
