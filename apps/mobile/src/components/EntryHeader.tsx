import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useEntryContext } from '../contexts/EntryContext';
import { api } from '../api/client';
import { EntryTarget } from '../services/entryIntents';

export function EntryHeader() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { entryIntent } = useEntryContext();
  const [previewData, setPreviewData] = useState<{ title: string; subtitle: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!entryIntent) {
      setPreviewData(null);
      setError(null);
      return;
    }
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (entryIntent.target.kind === 'group') {
          const res = await api.getInvitePreview(entryIntent.target.token);
          setPreviewData({
            title: `Join ${res.conversationTitle || 'Group'}`,
            subtitle: `${res.memberCount} ${res.memberCount === 1 ? 'member' : 'members'}`,
          });
        } else if (entryIntent.target.kind === 'person') {
          const res = await api.getPublicUser(entryIntent.target.userId);
          setPreviewData({
            title: res.name,
            subtitle: 'wants to connect on OpenChat',
          });
        } else if (entryIntent.target.kind === 'card') {
          const res = await api.getPublicCard(entryIntent.target.token);
          setPreviewData({
            title: `Add ${res.name}`,
            subtitle: res.headline || 'Sign in to add them on OpenChat',
          });
        }
      } catch (err: any) {
        setError(err.message || 'Unavailable');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [entryIntent?.target]);

  if (!entryIntent) return null;

  return (
    <View style={[styles.root, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
      {loading ? (
        <ActivityIndicator color={c.primary} />
      ) : error ? (
        <Text style={{ color: c.danger, fontWeight: '600' }}>{error}</Text>
      ) : previewData ? (
        <>
          <Text style={[styles.title, { color: c.textPrimary }]}>{previewData.title}</Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]}>{previewData.subtitle}</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    marginBottom: 20,
    width: '100%',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
});
