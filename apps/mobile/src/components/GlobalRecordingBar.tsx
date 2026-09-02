/**
 * Recording controls shown above the tab bar after leaving the origin chat
 * (build-90 pieces 1+2). Uses the shared Ink & Paper tokens and icon set.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRecording } from '../contexts/RecordingContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { AppIcon } from './AppIcon';
import { ToastMessage } from './ToastMessage';

interface Props {
  activeConversationId: string | null;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function GlobalRecordingBar({ activeConversationId }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const {
    status,
    conversationId,
    conversationTitle,
    elapsedMs,
    finishing,
    notice,
    cancel,
    stopAndSend,
  } = useRecording();

  const visible = status === 'recording' && activeConversationId !== conversationId;

  return (
    <>
      <ToastMessage visible={!!notice} message={notice ?? ''} />
      {visible ? (
        <View
          style={[styles.bar, { backgroundColor: c.surface, borderColor: c.border }]}
          accessibilityRole="toolbar"
          accessibilityLabel={`Recording voice message for ${conversationTitle || 'chat'}`}
        >
          <View style={[styles.dot, { backgroundColor: c.danger }]} />
          <Text style={[styles.elapsed, { color: c.textPrimary }]}>{formatElapsed(elapsedMs)}</Text>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: c.textSecondary }]}
          >
            {conversationTitle || 'Chat'}
          </Text>
          <TouchableOpacity
            onPress={() => void cancel()}
            disabled={finishing}
            style={styles.cancelButton}
            accessibilityRole="button"
            accessibilityLabel="Cancel voice message"
          >
            <AppIcon name="x" color={c.textMuted} size={16} />
            <Text style={[styles.cancelText, { color: c.textMuted }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => void stopAndSend()}
            disabled={finishing}
            style={[styles.sendButton, { backgroundColor: c.primary, opacity: finishing ? 0.5 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Stop and send voice message"
          >
            <AppIcon name="stop" color="#fff" size={13} />
            <Text style={styles.sendText}>Send</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  elapsed: {
    marginLeft: 8,
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  title: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
    fontSize: 13,
  },
  cancelButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    justifyContent: 'center',
  },
  cancelText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sendButton: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    borderRadius: 17,
    justifyContent: 'center',
  },
  sendText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});
