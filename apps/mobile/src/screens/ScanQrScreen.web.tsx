import { useCallback, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';
import { BrowserCardScanner, cardTokenFromScan } from '../utils/browserCardScanner';

export function ScanQrScreen() {
  const navigation = useNavigation<NavProp<'ScanQr'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const host = useRef<HTMLElement | null>(null);
  const scanner = useRef<BrowserCardScanner | null>(null);
  const opened = useRef(false);
  const focused = useRef(true);
  const [link, setLink] = useState('');
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'scanning' | 'unavailable'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const openCard = useCallback((token: string) => {
    if (opened.current || !focused.current) return;
    opened.current = true;
    scanner.current?.stop();
    scanner.current = null;
    navigation.replace('CardEntry', { token });
  }, [navigation]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    setCameraState('idle');
    return () => {
      focused.current = false;
      scanner.current?.stop();
      scanner.current = null;
    };
  }, []));

  const startCamera = async () => {
    if (scanner.current || opened.current) return;
    setMessage(null);
    setCameraState('starting');
    if (!host.current) {
      setCameraState('unavailable');
      setMessage('Camera preview is unavailable. Paste a card link below.');
      return;
    }
    const next = new BrowserCardScanner(host.current, {
      onCard: openCard,
      onUnsupportedCode: () => setMessage('This code is not an OpenChat card. Scan a card code or paste its link.'),
    });
    scanner.current = next;
    try {
      await next.start();
      if (focused.current && scanner.current === next) setCameraState('scanning');
    } catch {
      next.stop();
      if (scanner.current !== next) return;
      scanner.current = null;
      if (focused.current) {
        setCameraState('unavailable');
        setMessage('Camera access was denied or unavailable. Paste a card link, or scan it with your phone Camera app.');
      }
    }
  };

  const openPastedLink = () => {
    const token = cardTokenFromScan(link);
    if (token) openCard(token);
    else setMessage('Enter an OpenChat card link, such as https://chat.ideaflow.app/c/…');
  };

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Text style={[styles.heading, { color: c.textPrimary }]}>Scan a card</Text>
      <Text style={[styles.explanation, { color: c.textMetadata }]}>Point your camera at someone’s OpenChat card. You can review it before adding a friend.</Text>
      <View
        ref={node => { host.current = node as unknown as HTMLElement | null; }}
        style={[styles.preview, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}
      >
        {cameraState !== 'scanning' && cameraState !== 'starting' ? (
          <Text style={{ color: c.textMetadata, textAlign: 'center' }}>Camera is off</Text>
        ) : null}
      </View>
      {cameraState === 'idle' || cameraState === 'unavailable' ? (
        <TouchableOpacity style={[styles.button, { backgroundColor: c.primary }]} onPress={() => { void startCamera(); }} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: c.onPrimary }]}>Start camera</Text>
        </TouchableOpacity>
      ) : (
        <Text style={[styles.explanation, { color: c.textMetadata }]}>{cameraState === 'starting' ? 'Starting camera…' : 'Scanning for an OpenChat card…'}</Text>
      )}
      {message ? <Text accessibilityRole="alert" style={[styles.message, { color: c.danger }]}>{message}</Text> : null}
      <Text style={[styles.label, { color: c.textPrimary }]}>Or paste a card link</Text>
      <TextInput
        style={[styles.input, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.surface }]}
        value={link}
        onChangeText={setLink}
        placeholder="https://chat.ideaflow.app/c/…"
        placeholderTextColor={c.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="OpenChat card link"
      />
      <TouchableOpacity style={[styles.button, { backgroundColor: c.primary }]} onPress={openPastedLink} accessibilityRole="button">
        <Text style={[styles.buttonText, { color: c.onPrimary }]}>Open card</Text>
      </TouchableOpacity>
      <Text style={[styles.explanation, { color: c.textMetadata }]}>On a phone, you can also scan the QR with your Camera app and tap its OpenChat link.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', padding: 24, overflow: 'scroll' },
  heading: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  explanation: { fontSize: 15, textAlign: 'center', marginBottom: 16, maxWidth: 420 },
  preview: { width: '100%', maxWidth: 420, height: 270, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 16 },
  button: { width: '100%', maxWidth: 420, paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  message: { fontSize: 15, textAlign: 'center', marginBottom: 16, maxWidth: 420 },
  label: { fontSize: 16, fontWeight: '600', alignSelf: 'center', marginBottom: 8 },
  input: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 12 },
});
