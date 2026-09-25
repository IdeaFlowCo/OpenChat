/**
 * AddMeCardView — renders a StrangerCard, the server's consent projection of
 * an AddMe card. Used both by CardEntryScreen (what a scanner sees) and by
 * MyCardScreen's "preview as stranger", so the owner's preview is exactly the
 * stranger's view rather than a client-side approximation.
 */
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { Avatar } from './Avatar';
import type { StrangerCard } from '../api/client';

export function AddMeCardView({ card }: { card: StrangerCard }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const status = card.status ? [card.status.emoji, card.status.text].filter(Boolean).join(' ') : '';

  return (
    <View style={[styles.card, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
      <Avatar name={card.name} avatarUrl={card.avatarUrl ?? undefined} isBot={card.isBot} size={88} />
      <Text style={[styles.name, { color: c.textPrimary }]}>{card.name}</Text>
      {card.headline ? (
        <Text style={[styles.headline, { color: c.textPrimary }]}>{card.headline}</Text>
      ) : null}
      {status ? <Text style={[styles.status, { color: c.textMetadata }]}>{status}</Text> : null}
      {card.linkedIn ? (
        <TouchableOpacity onPress={() => void Linking.openURL(card.linkedIn!)} accessibilityRole="link">
          <Text style={[styles.link, { color: c.primary }]} numberOfLines={1}>
            {card.linkedIn.replace(/^https?:\/\//, '')}
          </Text>
        </TouchableOpacity>
      ) : null}
      {card.x ? (
        <TouchableOpacity onPress={() => void Linking.openURL(card.x!)} accessibilityRole="link">
          <Text style={[styles.link, { color: c.primary }]} numberOfLines={1}>
            {card.x.replace(/^https?:\/\//, '')}
          </Text>
        </TouchableOpacity>
      ) : null}
      {card.link ? (
        <TouchableOpacity onPress={() => void Linking.openURL(card.link!)} accessibilityRole="link">
          <Text style={[styles.link, { color: c.primary }]} numberOfLines={1}>
            {card.link.replace(/^https?:\/\//, '')}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
  },
  name: { fontSize: 22, fontWeight: '700', marginTop: 14, textAlign: 'center' },
  headline: { fontSize: 16, marginTop: 6, textAlign: 'center' },
  status: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  link: { fontSize: 14, marginTop: 10, fontWeight: '600' },
});
