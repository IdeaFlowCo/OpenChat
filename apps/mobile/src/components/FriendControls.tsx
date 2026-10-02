import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, type FriendState } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

export function FriendControls({ userId, onMessage }: { userId: string; onMessage?: () => Promise<void> }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [state, setState] = useState<FriendState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getFriendStatus(userId)
      .then(result => { if (active) setState(result.state); })
      .catch(() => { if (active) setError('Friend status unavailable'); });
    return () => { active = false; };
  }, [userId]);

  const act = useCallback(async (action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove') => {
    setBusy(true);
    setError(null);
    try { setState((await api.changeFriend(userId, action)).state); }
    catch { setError('Could not update friend request. Try again.'); }
    finally { setBusy(false); }
  }, [userId]);

  const message = async () => {
    if (!onMessage) return;
    setBusy(true);
    setError(null);
    try { await onMessage(); }
    catch { setError('Could not open message. Try again.'); }
    finally { setBusy(false); }
  };

  if (state === null) return error ? <Text style={{ color: c.textMetadata }}>{error}</Text> : <ActivityIndicator color={c.primary} />;
  const primary = state === 'none' ? 'Add friend' : state === 'incoming' ? 'Accept request' : state === 'outgoing' ? 'Request sent' : 'Friends';
  const action = state === 'none' ? 'request' : state === 'incoming' ? 'accept' : null;
  return (
    <View style={styles.root}>
      <TouchableOpacity
        style={[styles.button, { backgroundColor: action ? c.primary : c.surfaceElevated, borderColor: c.border }]}
        disabled={busy || !action}
        onPress={() => action && void act(action)}
      >
        <Text style={{ color: action ? c.onPrimary : c.textPrimary, fontWeight: '700' }}>{primary}</Text>
      </TouchableOpacity>
      {state === 'incoming' && <TouchableOpacity style={styles.secondary} disabled={busy} onPress={() => void act('decline')}><Text style={{ color: c.textSecondary }}>Decline</Text></TouchableOpacity>}
      {state === 'outgoing' && <TouchableOpacity style={styles.secondary} disabled={busy} onPress={() => void act('cancel')}><Text style={{ color: c.textSecondary }}>Cancel request</Text></TouchableOpacity>}
      {state === 'friends' && <TouchableOpacity style={styles.secondary} disabled={busy} onPress={() => void act('remove')}><Text style={{ color: c.textSecondary }}>Remove friend</Text></TouchableOpacity>}
      {state === 'friends' && onMessage && <TouchableOpacity style={styles.secondary} disabled={busy} onPress={() => void message()}><Text style={{ color: c.primary, fontWeight: '700' }}>Message</Text></TouchableOpacity>}
      {error && <Text style={{ color: c.danger }}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: 8, paddingVertical: 10 },
  button: { minWidth: 180, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  secondary: { paddingVertical: 8, paddingHorizontal: 16 },
});
