import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, type PublishedAsk } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, touchTarget, type } from '../theme/tokens';
/** This section reads sanitized viewer snapshots only, never another owner's asks. */
export function PublishedAsks({ publisherId }: { publisherId?: string }) {
  const { currentUser } = useChat();
  return <PublishedAskRows key={`${currentUser?.userId ?? 'anonymous'}:${publisherId ?? 'shared'}`} publisherId={publisherId} />;
}
function PublishedAskRows({ publisherId }: { publisherId?: string }) {
  const c = getColors(useTheme().scheme);
  const [items, setItems] = useState<PublishedAsk[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    let active = true; setItems([]); setLoading(true); setError(null);
    void api.listPublishedAsks(publisherId ?? null).then(result => { if (active) { setItems(result.publications); setCursor(result.nextCursor); } }).catch(err => { if (active) setError(err instanceof Error ? err.message : 'Published asks unavailable'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [publisherId]));
  const more = async () => { if (!cursor) return; setLoading(true); try { const result = await api.listPublishedAsks(publisherId ?? null, cursor); setItems(current => [...new Map([...current, ...result.publications].map(item => [item.id,item])).values()]); setCursor(result.nextCursor); setError(null); } catch (err) { setError(err instanceof Error ? err.message : 'Published asks unavailable'); setItems([]); } finally { setLoading(false); } };
  if (publisherId && !loading && !error && !items.length) return null;
  return <View style={{ padding: space[3], gap: space[3] }}>
    <Text style={{ ...type.heading, color: c.textPrimary }}>{publisherId ? 'Published asks' : 'Shared with me'}</Text>
    {error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text>}
    {!publisherId && !loading && !error && !items.length && <Text style={{ ...type.body, color: c.textMetadata }}>No asks are currently shared directly with you.</Text>}
    {items.map(item => <View key={item.id} style={{ borderColor: c.border, borderWidth: 1, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
      <Text style={{ ...type.label, color: c.textMetadata }}>{item.publisher.displayName} · {item.audience === 'public' ? 'Public' : 'Shared with you'} · {item.lifecycle}</Text>
      <Text style={{ ...type.body, color: c.textPrimary }}>{item.text}</Text>
    </View>)}
    {loading && <ActivityIndicator color={c.primary} />}
    {cursor && !error && <TouchableOpacity accessibilityRole="button" disabled={loading} onPress={() => void more()} style={{ minHeight: touchTarget, justifyContent: 'center' }}><Text style={{ ...type.label, color: c.primary }}>Load more</Text></TouchableOpacity>}
  </View>;
}
