/**
 * ScanQrScreen — fullscreen camera scanner for openchat:// QR codes.
 *
 * Parses the scanned URL with parseOpenChatUrl():
 *   - openchat://user/<id>   → calls createConversation + navigates to Chat
 *   - openchat://invite/<t>  → toast "Group invites not supported yet"
 *   - anything else          → Alert "Not a valid OpenChat code"
 *
 * Web: expo-camera does not provide reliable barcode scanning on web, so this
 * screen is hidden on web (the Settings rows are already gated with
 * Platform.OS !== 'web'). But if somehow reached, shows a graceful message.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { parseOpenChatUrl } from '../utils/parseOpenChatUrl';
import type { NavProp } from '../navigation/types';

export function ScanQrScreen() {
  const navigation = useNavigation<NavProp<'ScanQr'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { createConversation } = useChat();

  const [permission, requestPermission] = useCameraPermissions();
  const [processing, setProcessing] = useState(false);
  const lastScannedRef = useRef<string | null>(null);

  const handleBarcodeScan = useCallback(
    async (result: BarcodeScanningResult) => {
      // Debounce: skip if we already processed this exact value recently or
      // if an async handler is already in flight.
      if (processing || lastScannedRef.current === result.data) return;
      lastScannedRef.current = result.data;
      setProcessing(true);

      const parsed = parseOpenChatUrl(result.data);

      if (parsed.type === 'user') {
        try {
          const conv = await createConversation([parsed.userId], { type: 'direct' });
          // Go back first, then navigate to chat so the modal stack stays clean.
          navigation.replace('Chat', { conversationId: conv.id });
        } catch (err) {
          Alert.alert(
            'Could not open chat',
            err instanceof Error ? err.message : String(err),
            [{ text: 'OK', onPress: () => { lastScannedRef.current = null; } }]
          );
        } finally {
          setProcessing(false);
        }
        return;
      }

      if (parsed.type === 'invite') {
        Alert.alert(
          'Not supported yet',
          'Group invites are not supported yet. They are coming soon!',
          [{ text: 'OK', onPress: () => { lastScannedRef.current = null; setProcessing(false); } }]
        );
        return;
      }

      // Unknown QR
      Alert.alert(
        'Not a valid OpenChat code',
        'This QR code does not appear to be an OpenChat code.',
        [{ text: 'OK', onPress: () => { lastScannedRef.current = null; setProcessing(false); } }]
      );
    },
    [processing, createConversation, navigation]
  );

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Text style={[styles.webMsg, { color: c.textSecondary }]}>
          QR scanning is not available on web. Ask the other person to share their OpenChat link directly.
        </Text>
      </View>
    );
  }

  if (!permission) {
    // Permissions loading
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Text style={{ color: c.textSecondary }}>Loading…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Text style={[styles.permText, { color: c.textPrimary }]}>
          Camera access is needed to scan QR codes.
        </Text>
        <TouchableOpacity
          style={[styles.grantBtn, { backgroundColor: c.primary }]}
          onPress={requestPermission}
          activeOpacity={0.8}
        >
          <Text style={styles.grantBtnText}>Allow Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={handleBarcodeScan}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      />

      {/* Viewfinder overlay */}
      <View style={styles.overlay} pointerEvents="none">
        {/* Dark strips above/below the finder */}
        <View style={styles.overlayTop} />
        <View style={styles.overlayMiddleRow}>
          <View style={styles.overlaySide} />
          <View style={styles.finder}>
            {/* Corner brackets */}
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.overlaySide} />
        </View>
        <View style={styles.overlayBottom}>
          <Text style={styles.hint}>
            {processing ? 'Opening chat…' : 'Point at a QR code to add a contact'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const FINDER_SIZE = 240;
const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;
const CORNER_COLOR = '#ffffff';
const OVERLAY_COLOR = 'rgba(0,0,0,0.55)';

const styles = StyleSheet.create({
  root: { flex: 1 },
  webMsg: { fontSize: 16, textAlign: 'center', padding: 32, marginTop: 80 },
  permText: { fontSize: 17, textAlign: 'center', paddingHorizontal: 32, marginBottom: 24 },
  grantBtn: {
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
    marginHorizontal: 48,
  },
  grantBtnText: { color: '#fff', fontWeight: '700', fontSize: 16, textAlign: 'center' },

  // Overlay layout
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: 'column' },
  overlayTop: { flex: 1, backgroundColor: OVERLAY_COLOR },
  overlayMiddleRow: { flexDirection: 'row', height: FINDER_SIZE },
  overlaySide: { flex: 1, backgroundColor: OVERLAY_COLOR },
  finder: {
    width: FINDER_SIZE,
    height: FINDER_SIZE,
    backgroundColor: 'transparent',
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
    alignItems: 'center',
    paddingTop: 24,
  },
  hint: { color: '#ffffff', fontSize: 15, fontWeight: '500' },

  // Bracket corners
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderColor: CORNER_COLOR,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: 4,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: 4,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: 4,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderBottomRightRadius: 4,
  },
});
