/**
 * One of your own saved things — a company, idea, project or person who is not
 * on OpenChat — with your notes and everything you have linked to it. This is
 * how the private web of people, ideas and projects is browsed: each link
 * opens the next person or thing.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, type PrivateThingDetail } from '../api/client';
import { PrivateLinks, PrivateNotes } from '../components/PrivateGraph';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp, RouteProps } from '../navigation/types';

export function PrivateThingScreen() {
  const navigation = useNavigation<NavProp<'PrivateThing'>>();
  const { thingId } = useRoute<RouteProps<'PrivateThing'>>().params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [thing, setThing] = useState<PrivateThingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setThing(null); setError(null);
    api.getPrivateThing(thingId)
      .then(result => { if (active) setThing(result); })
      .catch(() => { if (active) setError('This item is not available.'); });
    return () => { active = false; };
  }, [thingId]);

  if (!thing) {
    return (
      <View style={[styles.root, styles.centered, { backgroundColor: c.background }]}>
        {error ? <Text style={{ color: c.textSecondary }}>{error}</Text> : <ActivityIndicator color={c.primary} />}
      </View>
    );
  }
  const subject = { kind: 'thing' as const, id: thing.id };
  return (
    <ScrollView style={[styles.root, { backgroundColor: c.background }]} contentContainerStyle={styles.content}>
      <Text style={{ color: c.textMetadata, fontSize: 13, textTransform: 'capitalize' }}>{thing.kind}</Text>
      <Text style={[styles.name, { color: c.textPrimary }]}>{thing.name}</Text>
      <Text style={{ color: c.textMetadata, fontSize: 13 }}>Private to you. Only you can see this.</Text>
      <PrivateLinks
        subject={subject} links={thing.links} onChange={links => setThing({ ...thing, links })}
        onOpenThing={id => navigation.push('PrivateThing', { thingId: id })}
        onOpenPerson={userId => navigation.navigate('ContactProfile', { userId })}
      />
      <PrivateNotes subject={subject} notes={thing.notes} onChange={notes => setThing({ ...thing, notes })} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, gap: 16 },
  name: { fontSize: 22, fontWeight: '700' },
});
