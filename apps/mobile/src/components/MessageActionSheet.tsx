import { MessageLinkActions } from './MessageLinkActions';
import { messageLinks } from '../utils/messageLinks';
/**
 * MessageActionSheet — everything you can do with one message.
 *
 * One list, grouped by intent so it reads at a glance:
 *   respond   Reply · Copy · Forward
 *   keep      Private to-do · Save to Stream · Pin to chat · Save to Vision
 *   more      Links · Translate · photos · OpenChat Agent · Tickle
 *   yours     Edit · Delete            (own messages)
 *   safety    Block · Report           (others' messages)
 *
 * Presentation follows the device: a bottom sheet under a finger, a menu at
 * the pointer for a right-click (`anchor`), and a centred dialog when a wide
 * window opens it without a pointer position (keyboard).
 */

import { useState, type ReactNode } from 'react';
import {
  Alert,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, sheetShadow, space, type } from '../theme/tokens';
import { Message, ReactionSummary } from '../api/client';
import { ReactionPicker } from './ReactionPicker';
import { AppIcon, type AppIconName } from './AppIcon';

export interface ReplyToData {
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
}

interface Props {
  visible: boolean;
  message: Message | null;
  isOwn: boolean;
  senderName: string;
  onDismiss: () => void;
  /** Reply action — sets replyTo in composer */
  onReply: (data: ReplyToData) => void;
  /** Forward action — opens ForwardPickerScreen (OpenChat-hhc) */
  onForward: (messageId: string) => void;
  /**
   * Forward to the user's PRIVATE Assistant DM (openchat-ug6). Drops the
   * quoted message into the Assistant conversation. Private — never posts
   * into the shared conversation.
   */
  onForwardToAssistant: (message: Message) => void;
  /**
   * "Ask about this…" variant (openchat-ug6) — prompts for a question first,
   * then forwards both the quoted message and the question to the Assistant.
   */
  onAskAssistant: (message: Message, question: string) => void;
  /** Keep the selection open unless the destination acknowledged a saved note. */
  onSaveToVision?: (message: Message, selection?: string) => Promise<boolean>;
  /**
   * Save the message into the user's Stream (with provenance).
   * `pin` additionally pins the new thought to this conversation so all
   * participants see it in the chat-scoped Stream view.
   */
  onSaveToThoughts: (message: Message, pin: boolean) => void;
  /** Edit action (own messages) — enters edit mode in composer */
  onEdit: (message: Message) => void;
  /** Delete action (own messages) — confirms and calls back */
  onDelete: (messageId: string) => void;
  /** React action — called with the emoji string */
  onReact: (messageId: string, emoji: string) => void;
  /** Block action — called with the sender's userId */
  onBlock: (userId: string, displayName: string) => void;
  /** Report action — called with messageId, reason, and optional freeform */
  onReport: (messageId: string, reason: string, freeform?: string) => void;
  /** Save the message's photos to the library / downloads (OpenChat-zwt4). */
  onSavePhotos?: (message: Message) => void;
  onTranslate?: (message: Message) => void;
  translateLanguage?: string;
  /** Tickle the sender (OpenChat-m0xp) — others' messages from people, not bots. */
  onTickle?: (userId: string, displayName: string) => void;
  /** Make a private to-do from this message, or open the one it already has. Nothing is sent. */
  onMakeTodo?: (message: Message) => void;
  hasTodo?: boolean;
  /** Pointer position of a right-click: the menu opens there instead of as a sheet. */
  anchor?: { x: number; y: number } | null;
}

interface ActionRow {
  key: string;
  label: string;
  hint?: string;
  icon?: AppIconName;
  emoji?: string;
  tone?: 'private' | 'danger';
  disabled?: boolean;
  onPress: () => void;
}
const WIDE_WINDOW = 700;
const MENU_WIDTH = 300;

const REPORT_REASONS = ['Spam', 'Inappropriate', 'Abuse', 'Other'] as const;
type ReportReason = (typeof REPORT_REASONS)[number];

export function MessageActionSheet({
  visible,
  message,
  isOwn,
  senderName,
  onDismiss,
  onReply,
  onForward,
  onForwardToAssistant,
  onAskAssistant,
  onSaveToVision,
  onSaveToThoughts,
  onEdit,
  onDelete,
  onReact,
  onBlock,
  onReport,
  onSavePhotos,
  onTranslate,
  onTickle,
  onMakeTodo,
  hasTodo = false,
  anchor = null,
  translateLanguage = 'English',
}: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const r = roles(c);
  const window = useWindowDimensions();
  const [menuSize, setMenuSize] = useState<{ width: number; height: number } | null>(null);

  // Sub-sheet state: null = main, 'report' = report picker, 'other' = freeform,
  // 'react' = emoji picker, 'assistant' = "ask about this" question prompt.
  const [subSheet, setSubSheet] = useState<null | 'report' | 'other' | 'react' | 'assistant' | 'links' | 'vision'>(null);
  const [freeformText, setFreeformText] = useState('');
  const [visionSelection, setVisionSelection] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  // Separate state for the assistant-question input so it doesn't collide with
  // the report freeform field.
  const [assistantQuestion, setAssistantQuestion] = useState('');

  const saveVision = async (selected?: string) => {
    if (!message || !onSaveToVision || visionBusy) return;
    setVisionBusy(true);
    try { if (await onSaveToVision(message, selected)) { setVisionSelection(''); handleDismiss(); } }
    finally { setVisionBusy(false); }
  };
  const handleDismiss = () => {
    setSubSheet(null);
    setFreeformText('');
    setAssistantQuestion('');
    onDismiss();
  };

  const handleReply = () => {
    if (!message) return;
    onReply({
      messageId: message.id,
      senderId: message.senderId,
      senderName: senderName,
      content: message.content,
    });
    handleDismiss();
  };

  // Press-and-hold → Copy (openchat-651). Uses RN's built-in Clipboard (same as
  // the rest of the app); a brief alert confirms since the sheet just closes.
  const photoCount = (message?.attachments ?? []).filter(a => a.type !== 'audio' && a.type !== 'file' && /^https?:/.test(a.url)).length;
  const saveVerb = Platform.OS === 'web' ? 'Download' : 'Save';
  const handleSavePhotos = () => {
    if (!message) return;
    handleDismiss();
    onSavePhotos?.(message);
  };

  const handleCopy = () => {
    if (!message) return;
    Clipboard.setString(message.content ?? '');
    handleDismiss();
  };

  const handleForwardPress = () => {
    if (!message) return;
    handleDismiss();
    onForward(message.id);
  };

  // "Forward to Assistant" — private, no prompt (openchat-ug6 v1 path).
  const handleForwardToAssistantPress = () => {
    if (!message) return;
    const msg = message;
    handleDismiss();
    onForwardToAssistant(msg);
  };

  // "Ask about this…" — submit the typed question to the Assistant.
  const handleAskAssistantSubmit = () => {
    if (!message) return;
    const q = assistantQuestion.trim();
    if (!q) return;
    const msg = message;
    handleDismiss();
    onAskAssistant(msg, q);
  };

  // Save to Stream / Save & pin (unified capture affordance).
  const handleSaveToThoughts = () => {
    if (!message) return;
    const msg = message;
    handleDismiss();
    onSaveToThoughts(msg, false);
  };

  const handleSaveAndPin = () => {
    if (!message) return;
    const msg = message;
    handleDismiss();
    onSaveToThoughts(msg, true);
  };

  const handleEditPress = () => {
    if (!message) return;
    onEdit(message);
    handleDismiss();
  };

  const handleDeletePress = () => {
    if (!message) return;
    Alert.alert(
      'Delete this message?',
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            handleDismiss();
            onDelete(message.id);
          },
        },
      ]
    );
  };

  const handleReactPick = (emoji: string) => {
    if (!message) return;
    onReact(message.id, emoji);
    handleDismiss();
  };

  const handleBlockPress = () => {
    if (!message) return;
    const name = senderName || 'this user';
    Alert.alert(
      `Block ${name}?`,
      `You won't receive messages from them anymore.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => {
            handleDismiss();
            onBlock(message.senderId, name);
          },
        },
      ]
    );
  };

  const handleReportReason = (reason: ReportReason) => {
    if (!message) return;
    if (reason === 'Other') {
      setSubSheet('other');
    } else {
      onReport(message.id, reason);
      handleDismiss();
    }
  };

  const handleReportOther = () => {
    if (!message) return;
    onReport(message.id, 'Other', freeformText.trim() || undefined);
    handleDismiss();
  };

  if (!visible || !message) return null;

  // A finger gets a bottom sheet; a wide window gets a centred dialog; a right-click gets a menu at the pointer.
  const wide = Platform.OS === 'web' && window.width >= WIDE_WINDOW;
  const overlayStyle = wide
    ? { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', justifyContent: 'center' as const, alignItems: 'center' as const }
    : { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' as const };

  const sheetStyle = [
    styles.sheet,
    {
      backgroundColor: c.surface,
      borderColor: c.border,
      paddingBottom: wide ? 8 : Platform.OS === 'ios' ? 34 : 16,
    },
    wide && [styles.dialog, sheetShadow],
  ];

  if (subSheet === 'links') {
    return <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
      <Pressable style={overlayStyle} onPress={handleDismiss}>
        <Pressable style={{ maxHeight: '90%' }} onPress={() => { /* retain sheet interaction */ }}>
          <View style={[sheetStyle, { flexShrink: 1 }]}>
            <Text style={[styles.title, { color: c.textPrimary }]}>Links</Text>
            <MessageLinkActions content={message.deletedAt ? '' : message.content} color={c.textPrimary} borderColor={c.divider} />
            <TouchableOpacity accessibilityRole="button" style={styles.cancelRow} onPress={() => setSubSheet(null)}>
              <Text style={{ color: c.textPrimary }}>Back to message actions</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" style={styles.cancelRow} onPress={handleDismiss}>
              <Text style={{ color: c.textPrimary }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>;
  }

  // ── Report sub-sheet ───────────────────────────────────────────────────────
  if (subSheet === 'report') {
    return (
      <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
        <Pressable style={overlayStyle} onPress={handleDismiss}>
          <Pressable onPress={() => { /* stop propagation */ }}>
            <View style={sheetStyle}>
              <View style={styles.handle} />
              <Text style={[styles.title, { color: c.textPrimary }]}>Why are you reporting this?</Text>
              {REPORT_REASONS.map((reason, i) => (
                <TouchableOpacity
                  key={reason}
                  style={[
                    styles.actionRow,
                    { borderColor: c.divider },
                    i < REPORT_REASONS.length - 1 && styles.actionRowBorder,
                  ]}
                  onPress={() => handleReportReason(reason)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.actionLabel, { color: reason === 'Spam' || reason === 'Abuse' ? c.danger : c.textPrimary }]}>
                    {reason}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={[styles.cancelRow, { borderColor: c.border }]} onPress={handleDismiss} activeOpacity={0.7}>
                <Text style={[styles.cancelLabel, { color: c.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // ── Freeform "Other" input ─────────────────────────────────────────────────
  if (subSheet === 'other') {
    return (
      <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
        <Pressable style={overlayStyle} onPress={handleDismiss}>
          <Pressable onPress={() => { /* stop propagation */ }}>
            <View style={sheetStyle}>
              <View style={styles.handle} />
              <Text style={[styles.title, { color: c.textPrimary }]}>Tell us more (optional)</Text>
              <TextInput
                style={[
                  styles.freeformInput,
                  { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border },
                ]}
                placeholder="Describe the issue…"
                placeholderTextColor={c.textMuted}
                value={freeformText}
                onChangeText={setFreeformText}
                multiline
                autoFocus
              />
              <TouchableOpacity
                style={[styles.submitBtn, { backgroundColor: c.primary }]}
                onPress={handleReportOther}
                activeOpacity={0.8}
              >
                <Text style={{ color: c.onPrimary, fontWeight: '600', fontSize: 16 }}>Submit report</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cancelRow, { borderColor: c.border }]} onPress={handleDismiss} activeOpacity={0.7}>
                <Text style={[styles.cancelLabel, { color: c.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // ── "Ask about this…" assistant question prompt (openchat-ug6) ─────────────
  if (subSheet === 'assistant') {
    return (
      <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
        <Pressable style={overlayStyle} onPress={handleDismiss}>
          <Pressable onPress={() => { /* stop propagation */ }}>
            <View style={sheetStyle}>
              <View style={styles.handle} />
              <Text style={[styles.title, { color: c.textPrimary }]}>Ask OpenChat Agent about this</Text>
              <View style={[styles.preview, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
                <Text style={[styles.previewSender, { color: c.textSecondary }]} numberOfLines={1}>
                  {senderName}
                </Text>
                <Text style={[styles.previewContent, { color: c.textPrimary }]} numberOfLines={2}>
                  {message.content}
                </Text>
              </View>
              <TextInput
                style={[
                  styles.freeformInput,
                  { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border },
                ]}
                placeholder="What do you want to ask about this message?"
                placeholderTextColor={c.textMuted}
                value={assistantQuestion}
                onChangeText={setAssistantQuestion}
                multiline
                autoFocus
              />
              <TouchableOpacity
                style={[styles.submitBtn, { backgroundColor: c.primary, opacity: assistantQuestion.trim() ? 1 : 0.5 }]}
                onPress={handleAskAssistantSubmit}
                disabled={!assistantQuestion.trim()}
                activeOpacity={0.8}
              >
                <Text style={{ color: c.onPrimary, fontWeight: '600', fontSize: 16 }}>Send to OpenChat Agent</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cancelRow, { borderColor: c.border }]} onPress={handleDismiss} activeOpacity={0.7}>
                <Text style={[styles.cancelLabel, { color: c.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // Derive which reactions the current user already has on this message.
  // This info is used to highlight active emoji in the picker.
  const myReactions = (message.reactions ?? [])
    .filter((r: ReactionSummary) => r.byMe)
    .map((r: ReactionSummary) => r.emoji);

  // ── "Save an excerpt to Vision" ────────────────────────────────────────────
  if (subSheet === 'vision') {
    return (
      <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
        <Pressable style={overlayStyle} onPress={handleDismiss}>
          <Pressable onPress={() => { /* stop propagation */ }}>
            <View style={sheetStyle}>
              {!wide && <View style={styles.handle} />}
              <Text style={[styles.title, { color: c.textPrimary }]}>Save an excerpt to Vision</Text>
              <TextInput accessibilityLabel="Selected text for Vision" value={visionSelection} onChangeText={setVisionSelection} multiline autoFocus
                placeholder="Paste or dictate the exact excerpt" placeholderTextColor={c.textMuted}
                style={[styles.freeformInput, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]} />
              <TouchableOpacity accessibilityRole="button" disabled={visionBusy || !visionSelection.trim()} onPress={() => { void saveVision(visionSelection); }}
                style={[styles.submitBtn, { backgroundColor: c.primary, opacity: visionSelection.trim() && !visionBusy ? 1 : 0.5 }]}>
                <Text style={{ color: c.onPrimary, ...type.bodyStrong }}>{visionBusy ? 'Saving…' : 'Save selected text to Vision'}</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" style={[styles.cancelRow, { borderColor: c.border }]} onPress={() => setSubSheet(null)}>
                <Text style={[styles.cancelLabel, { color: c.textSecondary }]}>Back to message actions</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // ── Main list, grouped by intent ───────────────────────────────────────────
  const live = !message.deletedAt;
  const hasText = live && !!message.content?.trim();
  const closeThen = (run: () => void) => () => { const current = message; handleDismiss(); if (current) run(); };
  const respond: ActionRow[] = live ? [
    { key: 'reply', label: 'Reply', icon: 'reply', onPress: handleReply },
    { key: 'copy', label: 'Copy', icon: 'copy', onPress: handleCopy },
    { key: 'forward', label: 'Forward', icon: 'forward', onPress: handleForwardPress },
  ] : [];
  const keep: ActionRow[] = [];
  if (live && onMakeTodo) keep.push({ key: 'todo', label: hasTodo ? 'Open your to-do' : 'Private to-do', hint: 'Only you see it. Nothing is sent.', icon: 'todo', tone: 'private', onPress: closeThen(() => onMakeTodo(message)) });
  if (hasText) {
    keep.push({ key: 'stream', label: 'Save to Stream', icon: 'bookmark', onPress: handleSaveToThoughts });
    keep.push({ key: 'pin', label: 'Pin to chat', hint: 'Saves it and shows it to everyone here', icon: 'pin', onPress: handleSaveAndPin });
  }
  if (hasText && onSaveToVision) {
    keep.push({ key: 'vision', label: visionBusy ? 'Saving…' : 'Save to Vision', hint: 'Private copy', icon: 'thought', disabled: visionBusy, onPress: () => { void saveVision(); } });
    keep.push({ key: 'vision-excerpt', label: 'Save an excerpt to Vision…', icon: 'thought', onPress: () => setSubSheet('vision') });
  }
  const more: ActionRow[] = [];
  if (live && messageLinks(message.content).length > 0) more.push({ key: 'links', label: 'Links · Open or copy', icon: 'link', onPress: () => setSubSheet('links') });
  if (hasText && onTranslate) more.push({ key: 'translate', label: `Translate to ${translateLanguage}`, icon: 'chat', onPress: closeThen(() => onTranslate(message)) });
  if (live && photoCount > 0 && onSavePhotos) more.push({ key: 'photos', label: photoCount === 1 ? `${saveVerb} photo` : `${saveVerb} all ${photoCount} photos`, icon: 'download', onPress: handleSavePhotos });
  if (live) {
    more.push({ key: 'agent', label: 'Forward to OpenChat Agent', icon: 'bot', onPress: handleForwardToAssistantPress });
    more.push({ key: 'agent-ask', label: 'Ask OpenChat Agent about this…', icon: 'sparkle', onPress: () => setSubSheet('assistant') });
  }
  if (!isOwn && onTickle && !message.sender?.isBot) more.push({ key: 'tickle', label: `Tickle ${senderName}`, emoji: '👉', onPress: closeThen(() => onTickle(message.senderId, senderName)) });
  const yours: ActionRow[] = isOwn && live ? [
    { key: 'edit', label: 'Edit message', icon: 'edit', onPress: handleEditPress },
    { key: 'delete', label: 'Delete message', icon: 'trash', tone: 'danger', onPress: handleDeletePress },
  ] : [];
  const safety: ActionRow[] = !isOwn ? [
    { key: 'block', label: `Block ${senderName}`, icon: 'block', tone: 'danger', onPress: handleBlockPress },
    { key: 'report', label: 'Report message', icon: 'flag', tone: 'danger', onPress: () => setSubSheet('report') },
  ] : [];
  const groups = [respond, keep, more, yours, safety].filter(group => group.length > 0);

  const menu = !!anchor && wide;
  const rowNodes: ReactNode[] = [];
  groups.forEach((group, index) => {
    if (index > 0) rowNodes.push(<View key={`divider-${index}`} style={[styles.groupDivider, { backgroundColor: c.divider }]} />);
    for (const row of group) {
      const color = row.tone === 'danger' ? c.danger : row.tone === 'private' ? r.private : c.textPrimary;
      rowNodes.push(
        <TouchableOpacity
          key={row.key}
          accessibilityRole={menu ? 'menuitem' : 'button'}
          accessibilityLabel={row.hint ? `${row.label}. ${row.hint}` : row.label}
          disabled={row.disabled}
          onPress={row.onPress}
          activeOpacity={0.7}
          style={[styles.actionRow, wide && styles.actionRowWide]}
        >
          <View style={styles.actionIconBox}>
            {row.emoji ? <Text style={styles.actionEmoji}>{row.emoji}</Text> : row.icon ? <AppIcon name={row.icon} color={color} size={wide ? 17 : 20} /> : null}
          </View>
          <View style={styles.actionText}>
            <Text style={[wide ? styles.actionLabelWide : styles.actionLabel, { color }]} numberOfLines={1}>{row.label}</Text>
            {!!row.hint && <Text style={[styles.actionHint, { color: c.textMetadata }]} numberOfLines={1}>{row.hint}</Text>}
          </View>
        </TouchableOpacity>,
      );
    }
  });

  if (menu && anchor) {
    // Opens at the pointer, nudged back inside the window once its size is known.
    const width = menuSize?.width ?? MENU_WIDTH;
    const height = menuSize?.height ?? 0;
    const left = Math.max(8, Math.min(anchor.x, window.width - width - 8));
    const top = Math.max(8, Math.min(anchor.y, window.height - height - 8));
    return (
      <Modal transparent animationType="none" visible={visible} onRequestClose={handleDismiss}>
        <Pressable style={styles.menuBackdrop} onPress={handleDismiss} accessibilityLabel="Close message actions">
          <Pressable onPress={() => { /* keep clicks inside the menu */ }}
            onLayout={event => setMenuSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
            style={[styles.menu, sheetShadow, { left, top, maxHeight: window.height - 16, backgroundColor: c.surface, borderColor: c.border, opacity: menuSize ? 1 : 0 }]}>
            <ScrollView keyboardShouldPersistTaps="handled" accessibilityRole="menu">
              <ReactionPicker myReactions={myReactions} onPick={handleReactPick} compact />
              {rowNodes}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
      <Pressable style={overlayStyle} onPress={handleDismiss}>
        <Pressable style={{ maxHeight: '90%' }} onPress={() => { /* stop propagation */ }}>
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
          <View style={sheetStyle}>
            {!wide && <View style={styles.handle} />}

            {/* Content preview */}
            <View style={[styles.preview, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
              <Text style={[styles.previewSender, { color: c.textSecondary }]} numberOfLines={1}>
                {senderName}
              </Text>
              <Text style={[styles.previewContent, { color: c.textPrimary }]} numberOfLines={2}>
                {message.deletedAt ? 'Message deleted' : message.content}
              </Text>
            </View>

            {/* Inline emoji reaction picker — always shown (OpenChat-7bd) */}
            <ReactionPicker myReactions={myReactions} onPick={handleReactPick} />

            {rowNodes}

            <TouchableOpacity
              style={[styles.cancelRow, { borderColor: c.border }]}
              onPress={handleDismiss}
              activeOpacity={0.7}
            >
              <Text style={[styles.cancelLabel, { color: c.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    paddingHorizontal: 0,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#9ca3af',
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    paddingBottom: 12,
    paddingHorizontal: 20,
  },
  preview: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  previewSender: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  previewContent: {
    fontSize: 14,
  },
  dialog: { width: 420, maxWidth: '92%', borderRadius: radius.lg, overflow: 'hidden' },
  menuBackdrop: { flex: 1 },
  menu: { position: 'absolute', width: MENU_WIDTH, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingVertical: space[1], overflow: 'hidden' },
  groupDivider: { height: StyleSheet.hairlineWidth, marginVertical: space[1], marginHorizontal: space[3] },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    minHeight: 48,
    paddingVertical: 8,
    gap: 14,
  },
  actionRowWide: { minHeight: 34, paddingVertical: 5, paddingHorizontal: space[3], gap: space[2] + 2 },
  actionText: { flex: 1, minWidth: 0 },
  actionLabelWide: { ...type.body, lineHeight: 20 },
  actionHint: { ...type.meta },
  actionRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionIcon: {
    fontSize: 20,
    width: 26,
    textAlign: 'center',
  },
  // Same footprint as actionIcon, for SVG AppIcon rows.
  actionIconBox: {
    width: 26,
    alignItems: 'center',
  },
  actionEmoji: { ...type.title, fontWeight: '400' },
  actionLabel: {
    fontSize: 17,
    fontWeight: '400',
  },
  cancelRow: {
    alignItems: 'center',
    paddingVertical: 16,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cancelLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  freeformInput: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
    minHeight: 80,
    maxHeight: 160,
  },
  submitBtn: {
    marginHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
});
