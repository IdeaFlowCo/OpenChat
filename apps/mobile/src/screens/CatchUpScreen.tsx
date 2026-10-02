/**
 * Catch up — people whose catch-up date has passed, soonest first. The
 * cadence is set on each person's "Private to you" card.
 */
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api, type CatchUpPerson } from '../api/client';
import { Avatar } from '../components/Avatar';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';

export function CatchUpScreen() {
  const navigation = useNavigation<NavProp<'CatchUp'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [due, setDue] = useState<CatchUpPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try { setDue((await api.listCatchUp()).due); }
    catch { setError('Could not load your catch-up list. Tap to try again.'); }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const caughtUp = async (userId: string) => {
    setBusy(userId);
    try { await api.updatePrivatePerson(userId, { contactedNow: true }); await refresh(); }
    catch { setError('Could not save that. Tap to try again.'); }
    finally { setBusy(null); }
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <Text style={{ color: c.textMetadata, fontSize: 13 }}>Private to you. Set how often on a person's contact info, under "Private to you".</Text>
      {error && <TouchableOpacity onPress={() => void refresh()}><Text style={{ color: c.danger }}>{error}</Text></TouchableOpacity>}
      {!due && !error && <ActivityIndicator color={c.primary} />}
      {due && due.length === 0 && <Text style={{ color: c.textMetadata }}>Nobody is due right now.</Text>}
      {due?.map(person => (
        <View key={person.userId} style={[styles.row, { borderBottomColor: c.divider }]}>
          <TouchableOpacity style={styles.identity} onPress={() => navigation.navigate('ContactProfile', { userId: person.userId })}>
            <Avatar name={person.name} avatarUrl={person.avatarUrl ?? undefined} size={40} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: c.textPrimary, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{`${person.important ? '★ ' : ''}${person.name}`}</Text>
              <Text style={{ color: c.textMetadata, fontSize: 13 }}>
                {person.lastContactAt ? `Last caught up ${new Date(person.lastContactAt).toLocaleDateString()}` : 'No catch-up recorded yet'}
              </Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void caughtUp(person.userId)} disabled={busy !== null}>
            <Text style={{ color: c.primary, fontWeight: '700' }}>Caught up</Text>
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
