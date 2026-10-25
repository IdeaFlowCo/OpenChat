/**
 * TickleLine (OpenChat-m0xp) — the centered system line a tickle card
 * renders: "Ana tickled you", "You tickled Bo", "Ana tickled Bo".
 */

import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, type } from '../theme/tokens';
import type { Message } from '../api/client';
import { parseTicklePayload, tickleLine } from '../utils/emojiMessage';

export function TickleLine({ message, myUserId }: { message: Message; myUserId?: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const payload = parseTicklePayload(message);
  const text = payload ? tickleLine(payload, myUserId) : message.content;
  return (
    <View style={styles.wrap} accessibilityRole="text">
      <Text style={[styles.text, { color: c.textMetadata, backgroundColor: c.surfaceElevated }]}>👉 {text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', marginVertical: 6 },
  text: { ...type.label, fontWeight: '400', paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.md, overflow: 'hidden' },
});
