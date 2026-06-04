/**
 * GroupInvitePreviewScreen — shown after scanning an invite QR or opening
 * an openchat://invite/<token> URL (OpenChat-240).
 *
 * GETs /api/chat/invites/:token, shows group title + member count,
 * and offers "Join" / "Cancel". On join POSTs /api/chat/invites/:token/accept
 * then navigates to the Chat screen. Expired/revoked/depleted tokens show
 * an inline error with a "Close" button.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { api } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import type { NavProp, RouteProps } from '../navigation/types';

interface InvitePreview {
  conversationId: string;
  conversationTitle: string | null;
  memberCount: number;
  expiresAt: string;
}

export function GroupInvitePreviewScreen() {
  const navigation = useNavigation<NavProp<'GroupInvitePreview'>>();
  const route = useRoute<RouteProps<'GroupInvitePreview'>>();
  const { token } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { conversations } = useChat();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getInvitePreview(token);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invite');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const handleJoin = async () => {
    setJoining(true);
    setError(null);
    try {
      const result = await api.acceptInvite(token);
      const convId = result.conversationId;
      // Replace this screen with the Chat screen so Back goes to Conversations
      navigation.replace('Chat', { conversationId: convId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join group');
      setJoining(false);
    }
  };

  const handleClose = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.replace('Conversations');
    }
  };

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} size="large" />
        <Text style={[styles.hint, { color: c.textSecondary, marginTop: 12 }]}>
          Loading invite...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <View style={[styles.card, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.errorHeading, { color: c.danger }]}>Invite Unavailable</Text>
          <Text style={[styles.errorMsg, { color: c.textSecondary }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.closeBtn, { borderColor: c.border }]}
            onPress={handleClose}
          >
            <Text style={{ color: c.textPrimary, fontWeight: '600' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Check if already a member of the group
  const alreadyMember = preview
    ? conversations.some(cv => cv.id === preview.conversationId)
    : false;

  const groupName = preview?.conversationTitle || 'Unnamed Group';
  const memberCount = preview?.memberCount ?? 0;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={[styles.card, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
        <View style={[styles.iconWrap, { backgroundColor: c.primary + '22' }]}>
          <Text style={styles.iconEmoji}>👥</Text>
        </View>

        <Text style={[styles.heading, { color: c.textPrimary }]}>
          You're invited to join
        </Text>

        <Text style={[styles.groupName, { color: c.primary }]} numberOfLines={2}>
          {groupName}
        </Text>

        <Text style={[styles.memberCount, { color: c.textSecondary }]}>
          {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </Text>

        {alreadyMember ? (
          <>
            <Text style={[styles.alreadyText, { color: c.textSecondary }]}>
              You are already a member of this group.
            </Text>
            <TouchableOpacity
              style={[styles.joinBtn, { backgroundColor: c.primary }]}
              onPress={() => {
                navigation.replace('Chat', { conversationId: preview!.conversationId });
              }}
            >
              <Text style={styles.joinBtnText}>Open Chat</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={[styles.joinBtn, { backgroundColor: c.primary, opacity: joining ? 0.6 : 1 }]}
            onPress={handleJoin}
            disabled={joining}
          >
            {joining
              ? <ActivityIndicator color="#ffffff" size="small" />
              : <Text style={styles.joinBtnText}>Join</Text>
            }
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={handleClose}
        >
          <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 28,
    paddingVertical: 32,
    alignItems: 'center',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  iconEmoji: {
    fontSize: 28,
  },
  heading: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
    textAlign: 'center',
  },
  groupName: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  memberCount: {
    fontSize: 14,
    marginBottom: 28,
  },
  joinBtn: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  joinBtnText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  cancelBtn: {
    paddingVertical: 10,
  },
  alreadyText: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  errorHeading: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center',
  },
  errorMsg: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 20,
  },
  closeBtn: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hint: {
    fontSize: 14,
  },
});
