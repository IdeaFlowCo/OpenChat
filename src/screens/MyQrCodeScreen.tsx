/**
 * MyQrCodeScreen — fullscreen modal that shows the current user's QR code.
 *
 * Encodes:  openchat://user/<userId>?v=1
 * Also shows the https://chat.globalbr.ai/u/<userId> URL as a share-friendly
 * fallback for non-app scanners.
 *
 * The Share button calls react-native's Share API to airdrop / message the URL.
 * On web: expo-camera QR scanning doesn't work, but QR generation via
 * react-native-qrcode-svg still does, so this screen is shown on all platforms.
 */

import { Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { OPENCHAT_URL } from '../api/client';

export function MyQrCodeScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser } = useChat();

  const userId = currentUser?.userId ?? '';
  // HTTPS-only QR (OpenChat-qr-onboard, 2026-06-02):
  // - With Associated Domains (OpenChat-84u.2): Universal Link opens app
  // - Without app: Safari → server-rendered '/u/<id>' landing with intent
  // Encoding openchat:// caused "Cannot open URL" for any user without the
  // app — broken viral acquisition. Now both code paths use HTTPS.
  const deepLinkUrl = `${OPENCHAT_URL}/u/${userId}`;
  const webUrl = deepLinkUrl;

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Add me on OpenChat: ${webUrl}`,
        url: webUrl,
        title: 'Add me on OpenChat',
      });
    } catch {
      // User cancelled — no action needed.
    }
  };

  if (!userId) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Text style={{ color: c.textSecondary }}>Not signed in</Text>
      </View>
    );
  }

  const qrFg = scheme === 'dark' ? '#ffffff' : '#000000';
  const qrBg = scheme === 'dark' ? '#1c1c1e' : '#ffffff';

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Text style={[styles.heading, { color: c.textPrimary }]}>My QR Code</Text>
      <Text style={[styles.sub, { color: c.textSecondary }]}>
        Show this to add me on OpenChat
      </Text>

      <View style={[styles.qrWrap, { backgroundColor: qrBg, borderColor: c.border }]}>
        <QRCode
          value={deepLinkUrl}
          size={220}
          color={qrFg}
          backgroundColor={qrBg}
        />
      </View>

      <Text style={[styles.urlLabel, { color: c.textMuted }]} numberOfLines={1} ellipsizeMode="middle">
        {webUrl}
      </Text>

      <TouchableOpacity
        style={[styles.shareBtn, { backgroundColor: c.primary }]}
        onPress={handleShare}
        activeOpacity={0.8}
      >
        <Text style={styles.shareBtnText}>Share</Text>
      </TouchableOpacity>
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
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 6,
  },
  sub: {
    fontSize: 15,
    marginBottom: 32,
    textAlign: 'center',
  },
  qrWrap: {
    padding: 20,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 16,
  },
  urlLabel: {
    fontSize: 11,
    marginBottom: 32,
    maxWidth: 280,
  },
  shareBtn: {
    paddingHorizontal: 48,
    paddingVertical: 14,
    borderRadius: 12,
  },
  shareBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
});
