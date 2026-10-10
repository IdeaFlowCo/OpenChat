import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { onProfileAskContext, setProfileAskAccount, readProfileAskContext, dismissProfileAskContext, type ProfileAskContext } from '../services/profileAskContext';
export function useProfileAskContext(userId: string | undefined, conversationId: string): [ProfileAskContext | null, () => void] {
  const [context, setContext] = useState<{ userId: string; conversationId: string; ask: ProfileAskContext } | null>(null);
  useEffect(() => {
    setProfileAskAccount(userId); setContext(null);
    const take = () => { const ask = userId && readProfileAskContext(userId, conversationId); setContext(ask && userId ? { userId, conversationId, ask } : null); };
    const unsubscribe = onProfileAskContext(take); take();
    return unsubscribe;
  }, [userId, conversationId]);
  return [context?.userId === userId && context?.conversationId === conversationId ? context.ask : null, () => { dismissProfileAskContext(userId, conversationId); setContext(null); }];
}
export function ProfileAskBanner({ ask, onDismiss, onInsert }: { ask: ProfileAskContext | null; onDismiss: () => void; onInsert: (text: string) => void }) {
  const c = getColors(useTheme().scheme);
  if (!ask || Date.parse(ask.expiresAt) <= Date.now()) return null;
  return <View style={{ padding: 12, gap: 8, backgroundColor: c.surface, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
    <Text style={{ color: c.textMetadata, fontWeight: '600' }}>About this ask</Text>
    <Text style={{ color: c.textPrimary }} numberOfLines={4}>{ask.text}</Text>
    <View style={{ flexDirection: 'row', gap: 16 }}>
      <TouchableOpacity accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => { onInsert(ask.text); onDismiss(); }}><Text style={{ color: c.primary }}>Add ask to draft</Text></TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={onDismiss}><Text style={{ color: c.textMetadata }}>Dismiss</Text></TouchableOpacity>
    </View>
  </View>;
}
