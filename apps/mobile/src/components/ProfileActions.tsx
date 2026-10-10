/**
 * The icon action row under a person's name (OpenChat-eo3n.6): Message first
 * and filled, then the friend state as a button, then Ask agent. Mirrors the
 * contact-info row in iMessage and WhatsApp. Undoing a friendship or a sent
 * request asks first, because the tile sits where a thumb lands.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, type FriendState } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, type } from '../theme/tokens';
import { confirmAction } from '../utils/confirm';
import { AppIcon, type AppIconName } from './AppIcon';

type FriendAction = 'request' | 'accept' | 'decline' | 'cancel' | 'remove';

function Tile({ icon, label, onPress, primary, disabled, accessibilityLabel }: {
  icon: AppIconName; label: string; onPress: () => void; primary?: boolean; disabled?: boolean; accessibilityLabel?: string;
}) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.tile, { backgroundColor: primary ? r.accent : r.card, borderColor: primary ? r.accent : r.line }, disabled && styles.disabled]}
    >
      <AppIcon name={icon} color={primary ? r.onAccent : r.text} size={20} />
      <Text style={[styles.label, { color: primary ? r.onAccent : r.text }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export function ProfileActions({ userId, name, isBot, onMessage, onAskAgent }: {
  userId: string; name: string; isBot?: boolean; onMessage: () => Promise<void>; onAskAgent?: () => void;
}) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const [state, setState] = useState<FriendState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isBot) return;
    let active = true;
    setState(null);
    api.getFriendStatus(userId)
      .then(result => { if (active) setState(result.state); })
      .catch(() => { if (active) setState(null); });
    return () => { active = false; };
  }, [userId, isBot]);

  const act = useCallback(async (action: FriendAction) => {
    setBusy(true); setError(null);
    try { setState((await api.changeFriend(userId, action)).state); }
    catch { setError('Could not update friend request. Try again.'); }
    finally { setBusy(false); }
  }, [userId]);

  const message = async () => {
    setBusy(true); setError(null);
    try { await onMessage(); }
    catch { setError('Could not open message. Try again.'); }
    finally { setBusy(false); }
  };

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <Tile icon="chat" label="Message" primary disabled={busy} onPress={() => void message()} accessibilityLabel={`Message ${name}`} />
        {state === 'none' && <Tile icon="plus" label="Add friend" disabled={busy} onPress={() => void act('request')} />}
        {state === 'incoming' && <Tile icon="check" label="Accept" disabled={busy} onPress={() => void act('accept')} accessibilityLabel="Accept friend request" />}
        {state === 'incoming' && <Tile icon="x" label="Decline" disabled={busy} onPress={() => void act('decline')} accessibilityLabel="Decline friend request" />}
        {state === 'outgoing' && <Tile icon="check" label="Requested" disabled={busy} accessibilityLabel="Friend request sent. Cancel request"
          onPress={() => confirmAction('Cancel friend request?', `${name} will no longer see your request.`, 'Cancel request', () => void act('cancel'))} />}
        {state === 'friends' && <Tile icon="people" label="Friends" disabled={busy} accessibilityLabel={`Friends with ${name}. Remove friend`}
          onPress={() => confirmAction(`Remove ${name} as a friend?`, 'Your chats stay. You can add them again later.', 'Remove friend', () => void act('remove'))} />}
        {onAskAgent && <Tile icon="sparkle" label="Ask agent" disabled={busy} onPress={onAskAgent} accessibilityLabel={`Ask agent about ${name}`} />}
      </View>
      {error && <Text accessibilityRole="alert" style={[type.meta, { color: r.danger, textAlign: 'center' }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space[2], marginTop: space[4] },
  row: { flexDirection: 'row', justifyContent: 'center', gap: space[2] },
  tile: {
    flex: 1, maxWidth: 96, minHeight: 60, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center', gap: space[1], paddingVertical: space[2], paddingHorizontal: space[1],
  },
  label: { ...type.caption, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
