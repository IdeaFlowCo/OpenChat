import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useChatTranslation } from '../contexts/TranslationContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { TRANSLATION_LANGUAGES, type TranslationMode } from '../services/translation';

export function TranslationControls({ conversationId }: { conversationId?: string }) {
  const { context, preference } = useChatTranslation(conversationId);
  const { scheme } = useTheme();
  const c = getColors(scheme);
  if (!context) return null;
  const inherited = !!conversationId && !context.preferences.chats[conversationId]?.mode;
  const modes: { value: TranslationMode; label: string }[] = [
    { value: 'ask', label: 'Offer to translate' }, { value: 'auto', label: 'Auto-translate' }, { value: 'off', label: 'Off · manual only' },
  ];
  return <View style={styles.panel}>
    <Text style={[type.title, { color: c.textPrimary }]}>{conversationId ? 'Translation for this chat' : 'Message translation'}</Text>
    <Text style={[type.meta, { color: c.textMetadata }]}>Only you see translations. Originals are kept. Messages you translate are processed by OpenChat’s AI service (Anthropic).</Text>
    <Text style={[type.meta, { color: c.textMetadata }]}>{conversationId ? 'Overrides your default for this chat.' : 'Default for all chats, with per-chat overrides.'} Saved for your account on this device.</Text>
    <Text style={[type.bodyStrong, { color: c.textPrimary, marginTop: space[2] }]}>Incoming messages</Text>
    {conversationId && <TouchableOpacity accessibilityRole="radio" accessibilityState={{ checked: !context.preferences.chats[conversationId], disabled: !context.ready }} disabled={!context.ready}
      onPress={() => context.resetChat(conversationId)} style={[styles.choice, { borderColor: c.border }]}>
      <Text style={[type.body, { color: c.textPrimary }]}>{!context.preferences.chats[conversationId] ? '✓ ' : ''}Use global default</Text>
    </TouchableOpacity>}
    {modes.map(mode => <TouchableOpacity key={mode.value} accessibilityRole="radio"
      accessibilityState={{ checked: !inherited && preference.mode === mode.value, disabled: !context.ready }} disabled={!context.ready}
      onPress={() => context.update({ mode: mode.value }, conversationId)} style={[styles.choice, { borderColor: c.border, backgroundColor: !inherited && preference.mode === mode.value ? c.surfaceElevated : c.surface }]}>
      <Text style={[type.body, { color: c.textPrimary }]}>{!inherited && preference.mode === mode.value ? '✓ ' : ''}{mode.label}</Text>
    </TouchableOpacity>)}
    <Text style={[type.bodyStrong, { color: c.textPrimary, marginTop: space[2] }]}>Translate to</Text>
    <View style={styles.languages}>{TRANSLATION_LANGUAGES.map(language => <TouchableOpacity key={language} accessibilityRole="radio"
      accessibilityState={{ checked: preference.language === language, disabled: !context.ready }} disabled={!context.ready}
      onPress={() => context.update({ language }, conversationId)} style={[styles.choice, { borderColor: c.border, backgroundColor: preference.language === language ? c.surfaceElevated : c.surface }]}>
      <Text style={[type.label, { color: c.textPrimary }]}>{preference.language === language ? '✓ ' : ''}{language}</Text>
    </TouchableOpacity>)}</View>
    {!!context.error && <Text accessibilityRole="alert" style={[type.meta, { color: c.danger }]}>{context.error}</Text>}
  </View>;
}

export function ChatTranslationBar({ conversationId, suggest }: { conversationId: string; suggest: boolean }) {
  const [open, setOpen] = useState(false);
  const { context, preference } = useChatTranslation(conversationId);
  const { scheme } = useTheme();
  const c = getColors(scheme);
  if (!context) return null;
  const offer = context.ready && suggest && preference.mode === 'ask';
  return <>
    <View style={[styles.bar, { borderColor: c.border, backgroundColor: c.surface }]}>
      <TouchableOpacity accessibilityRole="button" onPress={() => setOpen(true)} style={styles.barButton}>
        <Text style={[type.label, { color: c.textPrimary }]}>{preference.mode === 'auto' ? `Auto-translate · ${preference.language}` : 'Translate'}</Text>
      </TouchableOpacity>
      {offer && <>
        <Text style={[type.meta, { color: c.textMetadata, flexShrink: 1 }]}>Read this chat in {preference.language}?</Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => setOpen(true)} style={styles.barButton}>
          <Text style={[type.label, { color: c.primary }]}>Set up</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Dismiss translation offer for this chat"
          onPress={() => context.update({ mode: 'off' }, conversationId)} style={styles.barButton}>
          <Text style={[type.label, { color: c.textMetadata }]}>Not now</Text>
        </TouchableOpacity>
      </>}
    </View>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={[styles.backdrop, { backgroundColor: c.background }]}>
        <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityViewIsModal>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close translation settings" onPress={() => setOpen(false)} style={styles.barButton}>
            <Text style={[type.bodyStrong, { color: c.primary }]}>Done</Text>
          </TouchableOpacity>
          <ScrollView><TranslationControls conversationId={conversationId} /></ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  panel: { padding: space[4], gap: space[2] },
  choice: { minHeight: 44, paddingHorizontal: space[3], paddingVertical: space[2], justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingHorizontal: space[3], borderBottomWidth: StyleSheet.hairlineWidth, gap: space[2] },
  barButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space[2] },
  backdrop: { flex: 1, padding: space[4], alignItems: 'center', justifyContent: 'center' },
  sheet: { width: '100%', maxWidth: 540, maxHeight: '90%', borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
});
