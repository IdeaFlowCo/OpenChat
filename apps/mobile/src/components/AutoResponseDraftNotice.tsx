import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../api/client';
import { getSocket } from '../api/socket';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { Button } from './ui';

/**
 * Tells the owner, inside the chat, that their agent drafted a reply waiting
 * for approval. Nothing is sent from here; Review opens Auto replies.
 */
export function AutoResponseDraftNotice({ conversationId, onReview, ready = true }: { conversationId: string; onReview: () => void; ready?: boolean }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    // Requests fail until the account identity is verified; load once it is.
    if (!ready) return;
    try { setCount((await api.listAutoResponseDrafts(conversationId)).drafts.length); }
    catch { setCount(0); }
  }, [conversationId, ready]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const socket = getSocket();
    const onDraft = (payload: { conversationId?: string }) => { if (payload?.conversationId === conversationId) void load(); };
    const onMessage = (payload: { conversationId?: string }) => { if (payload?.conversationId === conversationId) void load(); };
    socket?.on('auto-response:draft', onDraft);
    socket?.on('message:new', onMessage);
    return () => { socket?.off('auto-response:draft', onDraft); socket?.off('message:new', onMessage); };
  }, [conversationId, load]);
  if (!count) return null;
  return <View accessibilityRole="summary" style={[styles.card, { backgroundColor: c.surface, borderColor: c.primary }]}>
    <Text style={{ ...type.label, color: c.textPrimary, flex: 1 }}>
      {count === 1 ? 'Your OpenChat agent drafted a reply here.' : `Your OpenChat agent drafted ${count} replies here.`} Nothing is sent until you approve.
    </Text>
    <Button label="Review" size="sm" variant="secondary" onPress={onReview} />
  </View>;
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], marginHorizontal: space[3], marginBottom: space[2] },
});
