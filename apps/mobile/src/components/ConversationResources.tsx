/** Member-only resources: never copied into the agent-readable content feed. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Text, TouchableOpacity, View } from 'react-native';
import { api, type ConversationResource } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { useStreamCompact } from '../services/streamDisplay';

export function ConversationResources({ conversationId, search }: { conversationId: string; search: string }) {
  const c = getColors(useTheme().scheme);
  const [compact] = useStreamCompact();
  const [rows, setRows] = useState<ConversationResource[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState<string>();
  const alive = useRef(true), busy = useRef(false);
  const load = useCallback(async (before?: string | null) => {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError('');
    try {
      const result = await api.listConversationResources(conversationId, before);
      if (!alive.current) return;
      setRows(old => before ? [...new Map([...old, ...result.resources].map(row => [row.id, row])).values()] : result.resources);
      setCursor(result.nextCursor); setPending(result.indexingPending || result.pending > 0);
      if (!result.enabled) setError('Links are not available for this chat yet.');
    } catch (e) {
      if (!alive.current) return;
      // Authorization failure removes previously loaded member-only material.
      if ([401, 403, 404].includes((e as { status?: number }).status || 0)) { setRows([]); setCursor(null); }
      setError(e instanceof Error ? e.message : 'Could not load links. Try again.');
    } finally { busy.current = false; if (alive.current) setLoading(false); }
  }, [conversationId]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  const save = async (row: ConversationResource) => {
    if (saving) return;
    setSaving(row.id); setError('');
    try {
      const result = await api.setConversationResourceSaved(conversationId, row.id, !row.saved);
      if (alive.current) setRows(old => old.map(item => item.id === row.id ? result.resource : item));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not save link.'); }
    finally { if (alive.current) setSaving(undefined); }
  };
  const query = search.trim().toLocaleLowerCase();
  const visible = rows.filter(row => !query || [row.title, row.url, row.kind, ...row.tags, ...row.sources].join(' ').toLocaleLowerCase().includes(query));
  return <View style={{ flex: 1 }}>
    <Text style={[type.meta, { padding: space[3], color: c.textMetadata }]}>Links · Members only{query ? ' · Searching loaded links' : ''}</Text>
    {pending && <Text style={[type.meta, { color: c.textMetadata, paddingHorizontal: space[3] }]}>More links are being indexed.</Text>}
    {error ? <View style={{ padding: space[3] }}><Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text><TouchableOpacity accessibilityRole="button" onPress={() => void load()} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: c.primary }}>Retry links</Text></TouchableOpacity></View> : null}
    <FlatList data={visible} keyExtractor={row => row.id} refreshing={loading} onRefresh={() => void load()}
      renderItem={({ item }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], padding: space[3], borderBottomWidth: 1, borderColor: c.border, borderRadius: radius.sm }}>
        <TouchableOpacity accessibilityRole="link" accessibilityLabel={item.title || item.host} onPress={() => { if (/^https?:\/\//i.test(item.url)) void Linking.openURL(item.url); }} style={{ flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' }}>
          <Text numberOfLines={compact ? 1 : 2} style={[type.label, { color: c.textPrimary }]}>{item.title || item.host}</Text>
          <Text numberOfLines={1} style={[type.meta, { color: c.textMetadata }]}>{item.kind} · {item.host} · {item.sources.join(', ') || 'OpenChat'}</Text>
          {!compact && <Text style={[type.meta, { color: c.textMetadata }]}>{item.tags.map(tag => `#${tag}`).join(' ')}</Text>}
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${item.saved ? 'Unsave' : 'Save'} ${item.title || item.host}`} disabled={!!saving} onPress={() => void save(item)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={[type.label, { color: c.primary }]}>{item.saved ? 'Saved' : 'Save'}</Text></TouchableOpacity>
      </View>}
      ListEmptyComponent={loading ? <ActivityIndicator color={c.primary} /> : <Text style={[type.body, { padding: space[4], color: c.textMetadata }]}>{query ? 'No matching loaded links.' : 'No links yet.'}</Text>}
      ListFooterComponent={cursor ? <TouchableOpacity accessibilityRole="button" disabled={loading} onPress={() => void load(cursor)} style={{ minHeight: 44, padding: space[3] }}><Text style={{ color: c.primary }}>Load more links</Text></TouchableOpacity> : null}
    />
  </View>;
}
