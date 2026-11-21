/**
 * A message from another network shown inside a conversation's timeline
 * (OpenChat-c8to.4). It reads like a message but is outlined and labelled
 * with its network, because it was never sent on OpenChat and cannot be
 * replied to, reacted to or edited here.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, type } from '../theme/tokens';
import { sourceNetworkName, type MirroredEntry } from '../utils/unifiedTimeline';
import { MessageText } from './MessageText';

const clock = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

export function MirroredMessageRow({ entry, showSender }: { entry: MirroredEntry; showSender: boolean }) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const { message } = entry;
  const network = sourceNetworkName(entry.network);
  if (message.kind === 'system') {
    return <Text style={[type.meta, styles.system, { color: r.textMeta }]}>{message.text ?? 'Chat event'} · {network}</Text>;
  }
  const body = message.kind === 'deleted'
    ? <Text style={[type.body, styles.quiet, { color: r.textMeta }]}>Deleted by the sender on {network}</Text>
    : <>
        {message.kind === 'media' ? <Text style={[type.meta, { color: r.textMeta }]}>{message.mediaType ? `${message.mediaType.charAt(0).toUpperCase()}${message.mediaType.slice(1)}` : 'Attachment'} · not mirrored</Text> : null}
        {message.text ? <MessageText content={message.text} color={r.text} onLongPress={() => {}} /> : null}
      </>;
  return (
    <View style={[styles.row, { justifyContent: entry.isOwn ? 'flex-end' : 'flex-start' }]} testID={`mirrored-message-${message.id}`}
      accessibilityLabel={`${entry.isOwn ? 'You' : entry.senderLabel} on ${network}`}>
      <View style={[styles.bubble, { borderColor: r.line, backgroundColor: r.canvas }]}>
        {showSender ? <Text style={[type.label, styles.sender, { color: r.textSecondary }]} numberOfLines={1}>{entry.isOwn ? 'You' : entry.senderLabel}</Text> : null}
        {body}
        <Text style={[type.caption, styles.meta, { color: r.textMeta }]}>{network} · {clock(message.sentAt)}{message.edited ? ' · Edited' : ''}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  bubble: { maxWidth: '82%', paddingHorizontal: space[3], paddingVertical: space[2], borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dashed', gap: 2 },
  sender: { fontWeight: '600' },
  meta: { alignSelf: 'flex-end' },
  quiet: { fontStyle: 'italic' },
  system: { textAlign: 'center', paddingVertical: space[1] },
});
