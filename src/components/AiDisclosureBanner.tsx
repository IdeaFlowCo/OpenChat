/**
 * AiDisclosureBanner — shown at the top of ChatScreen when a conversation
 * contains a bot participant and the user hasn't yet acknowledged it. (OpenChat-ds3)
 *
 * One-time per account: once accepted, the acceptedAt timestamp from the server
 * (stored in ChatContext) keeps it hidden across sessions.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';

export function AiDisclosureBanner() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { acceptAiDisclosure } = useChat();

  return (
    <View style={[styles.banner, { backgroundColor: c.primaryMuted, borderColor: c.primary }]}>
      <Text style={[styles.text, { color: c.textPrimary }]}>
        {'🤖'} This conversation includes an AI assistant. Your messages are sent to Anthropic to generate replies. Don't share secrets.
      </Text>
      <TouchableOpacity
        style={[styles.btn, { backgroundColor: c.primary }]}
        onPress={acceptAiDisclosure}
        activeOpacity={0.7}
        accessibilityLabel="Acknowledge AI disclosure"
      >
        <Text style={styles.btnText}>Got it</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  text: { fontSize: 13, lineHeight: 18 },
  btn: {
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
