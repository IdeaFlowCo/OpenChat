import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import {
  addMeCardUrl,
  api,
  type AddMeCardSettings,
  type MyAddMeCard,
  type StrangerCard,
} from '../api/client';
import { AddMeCardView } from '../components/AddMeCardView';

function confirmReset(onConfirm: () => void) {
  const title = 'Reset card link?';
  const message = 'Your current QR code and link will stop working. Anyone who already added you stays connected.';
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: onConfirm },
  ]);
}

export function MyCardScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { width } = useWindowDimensions();

  const [card, setCard] = useState<MyAddMeCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [headline, setHeadline] = useState('');
  const [linkedIn, setLinkedIn] = useState('');
  const [x, setX] = useState('');
  const [link, setLink] = useState('');
  const [strangerView, setStrangerView] = useState<StrangerCard | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const applyCard = useCallback((next: MyAddMeCard) => {
    setCard(next);
    setHeadline(next.settings.headline ?? '');
    setLinkedIn(next.settings.linkedIn ?? '');
    setX(next.settings.x ?? '');
    setLink(next.settings.link ?? '');
  }, []);

  useEffect(() => {
    api.getMyCard()
      .then(applyCard)
      .catch(() => setError('Could not load your card.'));
  }, [applyCard]);

  const save = async (patch: Partial<AddMeCardSettings>) => {
    setSaving(true);
    setError(null);
    try {
      applyCard(await api.updateMyCard(patch));
      setStrangerView(null);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not save.');
      if (card) applyCard(card);
    } finally {
      setSaving(false);
    }
  };

  const saveTextFields = () => {
    if (!card) return;
    const patch: Partial<AddMeCardSettings> = {};
    if (headline.trim() !== (card.settings.headline ?? '')) patch.headline = headline.trim() || null;
    if (linkedIn.trim() !== (card.settings.linkedIn ?? '')) patch.linkedIn = linkedIn.trim() || null;
    if (x.trim() !== (card.settings.x ?? '')) patch.x = x.trim() || null;
    if (link.trim() !== (card.settings.link ?? '')) patch.link = link.trim() || null;
    if (Object.keys(patch).length > 0) void save(patch);
  };

  const applyPreset = (preset: 'minimal' | 'business' | 'open') => {
    const patch: Partial<AddMeCardSettings> = {};
    if (preset === 'minimal') {
      patch.showAvatar = true;
      patch.showHeadline = false;
      patch.showLinkedIn = false;
      patch.showX = false;
      patch.showLink = false;
    } else if (preset === 'business') {
      patch.showAvatar = true;
      patch.showHeadline = true;
      patch.showLinkedIn = true;
      patch.showX = true;
      patch.showLink = false;
    } else if (preset === 'open') {
      patch.showAvatar = true;
      patch.showHeadline = true;
      patch.showLinkedIn = true;
      patch.showX = true;
      patch.showLink = true;
    }
    void save(patch);
  };

  const togglePreview = async () => {
    if (previewing) {
      setPreviewing(false);
      return;
    }
    if (!card) return;
    setPreviewing(true);
    try {
      setStrangerView(await api.getPublicCard(card.token));
    } catch {
      setError('Could not load the stranger preview.');
      setPreviewing(false);
    }
  };

  const handleShare = async () => {
    if (!card) return;
    const url = addMeCardUrl(card.token);
    try {
      await Share.share({ message: `Add me on OpenChat: ${url}`, url, title: 'Add me on OpenChat' });
    } catch {}
  };

  const handleReset = () => confirmReset(async () => {
    setSaving(true);
    try {
      applyCard(await api.rotateMyCard());
      setStrangerView(null);
      setPreviewing(false);
    } catch {
      setError('Could not reset your card link.');
    } finally {
      setSaving(false);
    }
  });

  if (!card) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        {error ? <Text style={{ color: c.textSecondary }}>{error}</Text> : <ActivityIndicator color={c.primary} size="large" />}
      </View>
    );
  }

  const url = addMeCardUrl(card.token);
  const qrSize = Math.max(180, Math.min(width - 96, 320));

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {previewing ? (
        <View style={styles.previewWrap}>
          <Text style={[styles.sub, { color: c.textMetadata }]}>
            This is exactly what someone sees after scanning your code.
          </Text>
          {strangerView ? <AddMeCardView card={strangerView} /> : <ActivityIndicator color={c.primary} />}
        </View>
      ) : (
        <View style={styles.qrPanel} accessibilityLabel="My card QR code">
          <QRCode value={url} size={qrSize} color="#000000" backgroundColor="#ffffff" ecl="M" />
          <Text style={styles.qrName} numberOfLines={1}>{card.preview.name}</Text>
          <Text style={styles.qrHint}>Scan to add me on OpenChat</Text>
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity style={[styles.actionBtn, { backgroundColor: c.primary }]} onPress={handleShare} accessibilityRole="button">
          <Text style={[styles.actionText, { color: c.onPrimary }]}>Share link</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, { borderColor: c.border, borderWidth: 1 }]} onPress={togglePreview} accessibilityRole="button">
          <Text style={[styles.actionText, { color: c.textPrimary }]}>{previewing ? 'Show QR' : 'Preview as stranger'}</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>PRESETS</Text>
      <View style={styles.presetRow}>
        <TouchableOpacity style={[styles.presetBtn, { backgroundColor: c.surface, borderColor: c.border }]} onPress={() => applyPreset('minimal')}>
          <Text style={[styles.presetText, { color: c.textPrimary }]}>Minimal</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.presetBtn, { backgroundColor: c.surface, borderColor: c.border }]} onPress={() => applyPreset('business')}>
          <Text style={[styles.presetText, { color: c.textPrimary }]}>Business Card</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.presetBtn, { backgroundColor: c.surface, borderColor: c.border }]} onPress={() => applyPreset('open')}>
          <Text style={[styles.presetText, { color: c.textPrimary }]}>Open</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>WHAT PEOPLE SEE</Text>
      <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.row, { borderBottomColor: c.divider }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: c.textPrimary }]}>Name</Text>
            <Text style={[styles.hint, { color: c.textMetadata }]}>Always shown · change it in Edit profile</Text>
          </View>
        </View>
        <View style={[styles.row, { borderBottomColor: c.divider }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: c.textPrimary }]}>Photo</Text>
            <Text style={[styles.hint, { color: c.textMetadata }]}>Your profile photo</Text>
          </View>
          <Switch value={card.settings.showAvatar} onValueChange={(v) => void save({ showAvatar: v })} disabled={saving} trackColor={{ false: c.border, true: c.primary }} />
        </View>
        
        <View style={[styles.fieldRow, { borderBottomColor: c.divider }]}>
          <View style={styles.fieldHeader}>
            <Text style={[styles.label, { color: c.textPrimary }]}>Headline</Text>
            <Switch value={card.settings.showHeadline} onValueChange={(v) => void save({ showHeadline: v })} disabled={saving} trackColor={{ false: c.border, true: c.primary }} />
          </View>
          <TextInput value={headline} onChangeText={setHeadline} onBlur={saveTextFields} onSubmitEditing={saveTextFields} placeholder="Optional · e.g. Founder at Ideaflow" placeholderTextColor={c.textMuted} maxLength={80} returnKeyType="done" style={[styles.input, { color: c.textPrimary, borderColor: c.border, opacity: card.settings.showHeadline ? 1 : 0.5 }]} editable={card.settings.showHeadline} />
        </View>

        <View style={[styles.fieldRow, { borderBottomColor: c.divider }]}>
          <View style={styles.fieldHeader}>
            <Text style={[styles.label, { color: c.textPrimary }]}>LinkedIn</Text>
            <Switch value={card.settings.showLinkedIn} onValueChange={(v) => void save({ showLinkedIn: v })} disabled={saving} trackColor={{ false: c.border, true: c.primary }} />
          </View>
          <TextInput value={linkedIn} onChangeText={setLinkedIn} onBlur={saveTextFields} onSubmitEditing={saveTextFields} placeholder="Optional · e.g. linkedin.com/in/you" placeholderTextColor={c.textMuted} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={200} returnKeyType="done" style={[styles.input, { color: c.textPrimary, borderColor: c.border, opacity: card.settings.showLinkedIn ? 1 : 0.5 }]} editable={card.settings.showLinkedIn} />
        </View>

        <View style={[styles.fieldRow, { borderBottomColor: c.divider }]}>
          <View style={styles.fieldHeader}>
            <Text style={[styles.label, { color: c.textPrimary }]}>X / Twitter</Text>
            <Switch value={card.settings.showX} onValueChange={(v) => void save({ showX: v })} disabled={saving} trackColor={{ false: c.border, true: c.primary }} />
          </View>
          <TextInput value={x} onChangeText={setX} onBlur={saveTextFields} onSubmitEditing={saveTextFields} placeholder="Optional · e.g. x.com/you" placeholderTextColor={c.textMuted} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={200} returnKeyType="done" style={[styles.input, { color: c.textPrimary, borderColor: c.border, opacity: card.settings.showX ? 1 : 0.5 }]} editable={card.settings.showX} />
        </View>

        <View style={[styles.fieldRow, { borderBottomWidth: 0 }]}>
          <View style={styles.fieldHeader}>
            <Text style={[styles.label, { color: c.textPrimary }]}>Other Link</Text>
            <Switch value={card.settings.showLink} onValueChange={(v) => void save({ showLink: v })} disabled={saving} trackColor={{ false: c.border, true: c.primary }} />
          </View>
          <TextInput value={link} onChangeText={setLink} onBlur={saveTextFields} onSubmitEditing={saveTextFields} placeholder="Optional · e.g. yoursite.com" placeholderTextColor={c.textMuted} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={200} returnKeyType="done" style={[styles.input, { color: c.textPrimary, borderColor: c.border, opacity: card.settings.showLink ? 1 : 0.5 }]} editable={card.settings.showLink} />
        </View>
      </View>
      <Text style={[styles.footnote, { color: c.textMetadata }]}>
        Never shown on your card: email, phone number, or account id.
      </Text>

      {error ? <Text style={[styles.error, { color: c.danger }]}>{error}</Text> : null}

      <TouchableOpacity onPress={handleReset} disabled={saving} style={styles.reset} accessibilityRole="button">
        <Text style={{ color: c.danger, fontWeight: '600' }}>Reset card link</Text>
        <Text style={[styles.hint, { color: c.textMetadata, textAlign: 'center' }]}>
          Stops your current QR and link from working
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 48 },
  qrPanel: { backgroundColor: '#ffffff', borderRadius: 20, padding: 24, alignItems: 'center' },
  qrName: { color: '#000000', fontSize: 20, fontWeight: '700', marginTop: 16, maxWidth: 320 },
  qrHint: { color: '#3a3a3c', fontSize: 14, marginTop: 2 },
  previewWrap: { width: '100%', alignItems: 'center', gap: 12 },
  sub: { fontSize: 14, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 20, width: '100%', maxWidth: 420 },
  actionBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  actionText: { fontWeight: '700', fontSize: 15 },
  sectionLabel: { alignSelf: 'stretch', maxWidth: 420, width: '100%', marginLeft: 'auto', marginRight: 'auto', fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginTop: 32, marginBottom: 8 },
  presetRow: { flexDirection: 'row', gap: 8, width: '100%', maxWidth: 420, marginBottom: 8 },
  presetBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  presetText: { fontSize: 13, fontWeight: '600' },
  section: { width: '100%', maxWidth: 420, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  fieldRow: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  label: { fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 13, marginTop: 2 },
  input: { fontSize: 15, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  footnote: { fontSize: 13, marginTop: 8, maxWidth: 420, width: '100%' },
  error: { fontSize: 14, marginTop: 16, textAlign: 'center' },
  reset: { marginTop: 32, alignItems: 'center', paddingVertical: 8 },
});
