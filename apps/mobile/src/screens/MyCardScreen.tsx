import { ConnectAgentLink } from '../components/ConnectAgentLink';
import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import {
  addMeCardUrl,
  api,
  type AddMeCardSettings,
  type MyAddMeCard,
  type StrangerCard,
} from '../api/client';
import { AddMeCardView } from '../components/AddMeCardView';
import { Avatar } from '../components/Avatar';
import { Button, Card, Chip, ListRow, SectionLabel } from '../components/ui';
import { radius, roles, sheetShadow, space, type } from '../theme/tokens';
import { isPlaceholderEmail } from '../utils/email';
import type { NavProp } from '../navigation/types';
import { currentCardUrl, shareCard, shareCardOnWhatsApp } from '../utils/cardSharing';
import { useFocusedAccountGuard } from '../hooks/useFocusedAccountGuard';
import { useIdeaflowAccountSwitch } from '../hooks/useIdeaflowAccountSwitch';

function confirmReset(onConfirm: () => void) {
  const title = 'Reset card link?';
  const message = 'Your current QR code and link will stop working. Anyone who already added you stays connected.';
  if (Platform.OS === 'web') {
    // RN-web's Alert.alert ignores buttons, so it cannot confirm anything.
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: onConfirm },
  ]);
}

export function MyCardScreen() {
  const navigation = useNavigation<NavProp<'MyCard'>>();
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const { width, height } = useWindowDimensions();
  const { currentUser, refreshConversations, signOut } = useChat();
  const ideaflowSwitch = useIdeaflowAccountSwitch();
  const guardAction = useFocusedAccountGuard(currentUser?.userId);
  const safeEmail = isPlaceholderEmail(currentUser?.email) ? undefined : currentUser?.email;

  const [card, setCard] = useState<MyAddMeCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingAgent, setOpeningAgent] = useState(false);
  const [headline, setHeadline] = useState('');
  const [linkedIn, setLinkedIn] = useState('');
  const [x, setX] = useState('');
  const [link, setLink] = useState('');
  const [strangerView, setStrangerView] = useState<StrangerCard | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  // A rotated link must never still say "Copied" (the clipboard holds the old one).
  useEffect(() => { setCopied(false); }, [card?.token]);

  const handleOpenAgent = async () => {
    if (openingAgent) return;
    setOpeningAgent(true);
    try {
      const conv = await api.ensureAssistant();
      await refreshConversations();
      navigation.navigate('Chat', { conversationId: conv.id });
    } catch (err) {
      Alert.alert('Could not open OpenChat Agent', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setOpeningAgent(false);
    }
  };

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
      const next = await api.updateMyCard(patch);
      applyCard(next);
      setStrangerView(null);
      // Keep an open preview current instead of leaving it on a spinner.
      if (previewing) setStrangerView(await api.getPublicCard(next.token));
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
    const isCurrent = guardAction();
    if (!isCurrent()) return;
    try {
      const url = await currentCardUrl();
      if (isCurrent()) await shareCard(url);
    } catch {
      if (!isCurrent()) return;
      try {
        const url = await currentCardUrl();
        if (!isCurrent()) return;
        await Clipboard.setStringAsync(url);
        if (isCurrent()) setError('Sharing is unavailable here. Your card link was copied.');
      } catch { if (isCurrent()) setError('Could not share your card link. Try again.'); }
    }
  };

  const handleWhatsApp = async () => {
    if (!card) return;
    const isCurrent = guardAction();
    if (!isCurrent()) return;
    try {
      const url = await currentCardUrl();
      if (isCurrent()) await shareCardOnWhatsApp(url);
    } catch { if (isCurrent()) setError('Could not open WhatsApp. Try Share link instead.'); }
  };

  const handleCopy = async () => {
    if (!card) return;
    try { await Clipboard.setStringAsync(addMeCardUrl(card.token)); setCopied(true); }
    catch { setError('Could not copy your link. Try again.'); }
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

  // Only the very first load blocks the screen. If the card request fails,
  // the card-specific sections are replaced by an inline error while the
  // identity header and the Profile/Settings/Sign out menu still render —
  // Profile is the single "Me" door (docs/surface-map.md), so it must never
  // strand the user without Settings or Sign out (OpenChat-3ar0).
  if (!card && !error) {
    return (
      <View style={[styles.center, { backgroundColor: r.canvas }]}>
        <ActivityIndicator color={r.accent} size="large" />
      </View>
    );
  }

  const url = card ? addMeCardUrl(card.token) : '';
  // Shrink the code on short screens (landscape phones, small browser windows).
  const qrSize = Math.max(140, Math.min(width - 112, 260, (height || 800) * 0.32));
  const name = card?.preview.name || currentUser?.name || 'Your profile';
  const headerHeadline = card?.settings.headline || (currentUser as any)?.statusMessage;
  const myLinks = card ? [
    card.settings.linkedIn ? { label: 'LinkedIn', url: card.settings.linkedIn } : null,
    card.settings.x ? { label: 'X', url: card.settings.x } : null,
    card.settings.link ? { label: 'Website', url: card.settings.link } : null,
  ].filter((item): item is { label: string; url: string } => !!item) : [];

  // Per-field audience. Today a field is either on your card (anyone with the
  // card link, and friends on your profile) or only on this screen. Only
  // audiences the server honours are offered (OpenChat-eo3n.7).
  const audienceRow = (label: string, shown: boolean, onChange: (show: boolean) => void, field: ReactNode, divider: boolean) => (
    <View style={[styles.fieldRow, divider && { borderTopColor: r.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.fieldHeader}>
        <Text style={[type.bodyStrong, styles.fieldLabel, { color: r.text }]}>{label}</Text>
        <View style={styles.audience} accessibilityRole="radiogroup" accessibilityLabel={`Who sees your ${label}`}>
          <Chip label="Friends & card" selected={shown} disabled={saving} onPress={() => { if (!shown) onChange(true); }} accessibilityRole="radio" accessibilityLabel={`${label}: friends and card`} />
          <Chip label="Only me" icon="lock" selected={!shown} disabled={saving} onPress={() => { if (shown) onChange(false); }} accessibilityRole="radio" accessibilityLabel={`${label}: only me`} />
        </View>
      </View>
      {field}
    </View>
  );
  const input = (value: string, onChangeText: (v: string) => void, placeholder: string, extra: Partial<ComponentProps<typeof TextInput>> = {}) => (
    <TextInput value={value} onChangeText={onChangeText} onBlur={saveTextFields} onSubmitEditing={saveTextFields} placeholder={placeholder}
      placeholderTextColor={r.decoration} returnKeyType="done" style={[styles.input, { color: r.text, backgroundColor: r.input, borderColor: r.line }]} {...extra} />
  );
  const urlInput = { autoCapitalize: 'none' as const, autoCorrect: false, keyboardType: 'url' as const, maxLength: 200 };

  return (
    <ScrollView
      style={{ backgroundColor: r.canvas }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Identity first: who you are, then one door to share it. */}
      <View style={styles.identity}>
        <Avatar name={name} email={safeEmail} avatarUrl={currentUser?.avatarUrl ?? undefined} size={88} />
        <Text style={[type.heading, styles.centered, { color: r.text }]} numberOfLines={1}>{name}</Text>
        {!!headerHeadline && <Text style={[type.body, styles.centered, { color: r.textSecondary }]} numberOfLines={2}>{headerHeadline}</Text>}
        {myLinks.length > 0 && (
          <View style={styles.linkChips}>
            {myLinks.map(item => <Chip key={item.label} icon="link" label={item.label} onPress={() => void Linking.openURL(item.url)} accessibilityLabel={`${item.label}: ${item.url}`} />)}
          </View>
        )}
        <View style={styles.identityActions}>
          {card && <Button variant="primary" icon="share" label="Share profile" onPress={() => { setCopied(false); setError(null); setSharing(true); }} />}
          <Button icon="edit" label="Edit profile" onPress={() => navigation.navigate('ProfileEdit')} />
        </View>
      </View>

      {!card ? (
        <Card style={styles.block}><Text style={[type.label, styles.centered, { color: r.textMeta }]}>{error}</Text></Card>
      ) : (
      <>
      <SectionLabel style={styles.block}>What people see</SectionLabel>
      <Card padding="none" style={styles.block}>
        <View style={styles.fieldRow}>
          <View style={styles.fieldHeader}>
            <Text style={[type.bodyStrong, styles.fieldLabel, { color: r.text }]}>Name</Text>
            <Chip label="Everyone" selected />
          </View>
        </View>
        <View style={[styles.fieldRow, { borderTopColor: r.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
          <View style={styles.fieldHeader}>
            <Text style={[type.bodyStrong, styles.fieldLabel, { color: r.text }]}>Photo</Text>
            <View style={styles.audience} accessibilityRole="radiogroup" accessibilityLabel="Who sees your photo">
              <Chip label="Everyone" selected={card.settings.showAvatar} disabled={saving} onPress={() => { if (!card.settings.showAvatar) void save({ showAvatar: true }); }} accessibilityRole="radio" accessibilityLabel="Photo: everyone" />
              <Chip label="Not on card" selected={!card.settings.showAvatar} disabled={saving} onPress={() => { if (card.settings.showAvatar) void save({ showAvatar: false }); }} accessibilityRole="radio" accessibilityLabel="Photo: not on card" />
            </View>
          </View>
        </View>
        {audienceRow('Headline', card.settings.showHeadline, v => void save({ showHeadline: v }), input(headline, setHeadline, 'e.g. Founder at Ideaflow', { maxLength: 80 }), true)}
        {audienceRow('LinkedIn', card.settings.showLinkedIn, v => void save({ showLinkedIn: v }), input(linkedIn, setLinkedIn, 'linkedin.com/in/you', urlInput), true)}
        {audienceRow('X', card.settings.showX, v => void save({ showX: v }), input(x, setX, 'x.com/you', urlInput), true)}
        {audienceRow('Website', card.settings.showLink, v => void save({ showLink: v }), input(link, setLink, 'yoursite.com', urlInput), true)}
      </Card>
      <Text style={[type.meta, styles.block, styles.footnote, { color: r.textMeta }]}>
        Friends see these on your profile, and so does anyone you give your card link. Email, phone number and account id are never shown.
      </Text>
      <View style={[styles.block, styles.previewRow]}>
        <Button size="sm" variant="ghost" icon="info" label={previewing ? 'Hide preview' : 'Preview your card'} onPress={() => void togglePreview()} />
      </View>
      {previewing && (
        <View style={[styles.block, styles.previewWrap]}>
          {strangerView ? <AddMeCardView card={strangerView} /> : <ActivityIndicator color={r.accent} />}
        </View>
      )}
      </>
      )}

      <SectionLabel style={styles.block}>Profile & settings</SectionLabel>
      <Card padding="none" style={styles.block}>
        <ListRow icon="edit" title="Edit profile" subtitle="Name, photo, status and directory settings" onPress={() => navigation.navigate('ProfileEdit')} />
        <ListRow icon="bot" title="OpenChat Agent" subtitle="Private conversation, asks and agent coordination" divider disabled={openingAgent}
          trailing={openingAgent ? <ActivityIndicator size="small" color={r.accent} /> : undefined} chevron={!openingAgent} onPress={() => void handleOpenAgent()} />
        <View style={{ borderTopColor: r.line, borderTopWidth: StyleSheet.hairlineWidth }}><ConnectAgentLink detail /></View>
        <ListRow icon="settings" title="Settings" subtitle="Preferences, notifications and account" divider onPress={() => navigation.navigate('Settings')} />
      </Card>

      {/* Sign out lives on Profile because the avatar is the one "Me" door on
          every width (phone header, desktop sidebar): Chats › avatar › Sign out
          is two taps everywhere. Settings › Account carries the same row. */}
      <SectionLabel style={styles.block}>Account</SectionLabel>
      <Card padding="none" style={styles.block}>
        {ideaflowSwitch.available && (
          <ListRow icon="people" title="Switch account" subtitle="Use another Ideaflow account" disabled={ideaflowSwitch.switching} chevron={false}
            trailing={ideaflowSwitch.switching ? <ActivityIndicator size="small" color={r.accent} /> : undefined} onPress={() => { void ideaflowSwitch.switchAccount(); }} />
        )}
        <ListRow icon="logout" title="Sign out" destructive chevron={false} divider={ideaflowSwitch.available}
          subtitle={safeEmail ? `Signed in as ${safeEmail}` : 'Return to the sign-in screen on this device'} onPress={() => { void signOut(); }} />
      </Card>

      {card && error && !sharing ? <Text style={[type.label, styles.error, { color: r.danger }]}>{error}</Text> : null}

      {card && (
        <Modal visible={sharing} transparent animationType="fade" onRequestClose={() => setSharing(false)}>
          <View style={styles.backdrop}>
            {/* Tapping outside closes, so the sheet never traps anyone (iOS has no back key). */}
            <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setSharing(false)} accessibilityLabel="Close share sheet" accessibilityRole="button" />
            <View style={[styles.sheet, sheetShadow, { backgroundColor: r.card, borderColor: r.line }]} accessibilityViewIsModal>
              <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
              <View style={styles.sheetHeader}>
                <Text accessibilityRole="header" style={[type.title, { color: r.text }]}>Share profile</Text>
                <Button size="sm" variant="ghost" label="Done" onPress={() => setSharing(false)} />
              </View>
              <View style={styles.qrPanel} accessibilityLabel="My card QR code">
                <QRCode value={url} size={qrSize} color="#000000" backgroundColor="#ffffff" ecl="M" />
                <Text style={[type.title, styles.qrName]} numberOfLines={1}>{card.preview.name}</Text>
                <Text style={[type.label, styles.qrHint]}>Scan to send me a friend request</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Copy link" onPress={() => void handleCopy()} style={[styles.linkRow, { backgroundColor: r.input, borderColor: r.line }]}>
                <Text style={[type.label, styles.linkText, { color: r.textSecondary }]} numberOfLines={1}>{url.replace(/^https?:\/\//, '')}</Text>
                <Text style={[type.label, { color: r.text, fontWeight: '600' }]}>{copied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
              <View style={styles.sheetActions}>
                <Button variant="primary" icon="share" label="Share link" block onPress={() => void handleShare()} />
                <Button label="Open in WhatsApp" block onPress={() => void handleWhatsApp()} />
              </View>
              {error ? <Text style={[type.meta, { color: r.danger }]}>{error}</Text> : null}
              <Button size="sm" variant="ghost" label="Reset card link" disabled={saving} onPress={handleReset}
                accessibilityHint="Stops your current QR code and link from working" style={styles.reset} />
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[6] },
  content: { alignItems: 'center', paddingHorizontal: space[4], paddingTop: space[6], paddingBottom: space[10] },
  block: { width: '100%', maxWidth: 560 },
  identity: { alignItems: 'center', gap: space[2], width: '100%', maxWidth: 560 },
  centered: { textAlign: 'center', maxWidth: 340 },
  linkChips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2], marginTop: space[1] },
  identityActions: { flexDirection: 'row', gap: space[2], marginTop: space[3] },
  fieldRow: { paddingHorizontal: space[4], paddingVertical: space[3], gap: space[2] },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2], flexWrap: 'wrap' },
  fieldLabel: { flexShrink: 1 },
  audience: { flexDirection: 'row', gap: space[1] + 2 },
  input: { ...type.body, paddingHorizontal: space[3], paddingVertical: space[2] + 2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  footnote: { marginTop: space[2] },
  previewRow: { alignItems: 'flex-start', marginTop: space[1] },
  previewWrap: { alignItems: 'center', gap: space[3], marginTop: space[2] },
  error: { marginTop: space[4], textAlign: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(28, 25, 23, 0.35)', justifyContent: 'center', alignItems: 'center', padding: space[4] },
  sheet: { width: '100%', maxWidth: 400, maxHeight: '92%', borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  sheetBody: { padding: space[4], gap: space[3] },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qrPanel: {
    // Fixed white panel with generous padding = the QR quiet zone. High
    // contrast in every theme is the point; do not theme this.
    backgroundColor: '#ffffff',
    borderRadius: radius.lg,
    padding: space[5],
    alignItems: 'center',
    alignSelf: 'center',
  },
  qrName: { color: '#000000', marginTop: space[3], maxWidth: 280 },
  qrHint: { color: '#3a3a3c', marginTop: 2 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44, paddingHorizontal: space[3], borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  linkText: { flex: 1, minWidth: 0 },
  sheetActions: { gap: space[2] },
  reset: { alignSelf: 'center' },
});
