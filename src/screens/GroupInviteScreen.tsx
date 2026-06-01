/**
 * GroupInviteScreen — modal for group owners to generate, share, and revoke
 * an invite QR / link (OpenChat-240).
 *
 * On open, calls POST /api/chat/conversations/:id/invites to get or create
 * an active invite. Shows a QR code for the invite URL plus "Copy link" and
 * "Revoke" actions. Non-owners cannot navigate here (enforced upstream in
 * GroupSettingsScreen which only shows the button for isOwner).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { api } from '../api/client';
import type { NavProp, RouteProps } from '../navigation/types';

interface InviteData {
  token: string;
  url: string;
  expiresAt: string;
  usesLeft: number;
}

export function GroupInviteScreen() {
  const navigation = useNavigation<NavProp<'GroupInvite'>>();
  const route = useRoute<RouteProps<'GroupInvite'>>();
  const { conversationId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [invite, setInvite] = useState<InviteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadInvite = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.createInvite(conversationId);
      setInvite(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadInvite();
  }, [loadInvite]);

  const handleCopy = () => {
    if (!invite) return;
    Clipboard.setString(invite.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = () => {
    if (!invite) return;
    Alert.alert(
      'Revoke invite?',
      'Anyone with the current link or QR code will no longer be able to join.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setRevoking(true);
            try {
              await api.revokeInvite(conversationId, invite.token);
              // Generate a new invite immediately
              await loadInvite();
            } catch (err) {
              Alert.alert('Revoke failed', err instanceof Error ? err.message : String(err));
            } finally {
              setRevoking(false);
            }
          },
        },
      ]
    );
  };

  const qrFg = scheme === 'dark' ? '#ffffff' : '#000000';
  const qrBg = scheme === 'dark' ? '#1c1c1e' : '#ffffff';

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} size="large" />
        <Text style={[styles.hint, { color: c.textSecondary, marginTop: 12 }]}>
          Creating invite...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: c.primary, marginTop: 16 }]}
          onPress={loadInvite}
        >
          <Text style={styles.btnText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.cancelBtn]}
          onPress={() => navigation.goBack()}
        >
          <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Text style={[styles.heading, { color: c.textPrimary }]}>Invite via QR / Link</Text>
      <Text style={[styles.sub, { color: c.textSecondary }]}>
        Anyone who scans this or opens the link can join the group.
      </Text>

      {invite && (
        <>
          <View style={[styles.qrWrap, { backgroundColor: qrBg, borderColor: c.border }]}>
            <QRCode
              value={invite.url}
              size={220}
              color={qrFg}
              backgroundColor={qrBg}
            />
          </View>

          <Text style={[styles.urlLabel, { color: c.textMuted }]} numberOfLines={2} ellipsizeMode="middle">
            {invite.url}
          </Text>

          <Text style={[styles.meta, { color: c.textMuted }]}>
            {invite.usesLeft} uses remaining
          </Text>

          <TouchableOpacity
            style={[styles.btn, { backgroundColor: c.primary }]}
            onPress={handleCopy}
            activeOpacity={0.8}
          >
            <Text style={styles.btnText}>{copied ? 'Copied!' : 'Copy link'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.revokeBtn, { borderColor: c.danger }]}
            onPress={handleRevoke}
            disabled={revoking}
            activeOpacity={0.8}
          >
            {revoking
              ? <ActivityIndicator color={c.danger} size="small" />
              : <Text style={{ color: c.danger, fontWeight: '600' }}>Revoke &amp; regenerate</Text>
            }
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 40,
  },
  heading: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  sub: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 28,
  },
  qrWrap: {
    padding: 20,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 16,
  },
  urlLabel: {
    fontSize: 11,
    marginBottom: 6,
    maxWidth: 280,
    textAlign: 'center',
  },
  meta: {
    fontSize: 12,
    marginBottom: 24,
  },
  btn: {
    paddingHorizontal: 48,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 12,
    minWidth: 200,
    alignItems: 'center',
  },
  btnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  revokeBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 200,
    alignItems: 'center',
    marginTop: 4,
  },
  cancelBtn: {
    paddingVertical: 12,
    marginTop: 8,
  },
  errorText: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 8,
  },
  hint: {
    fontSize: 14,
  },
});
