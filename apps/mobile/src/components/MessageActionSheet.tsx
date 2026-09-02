/**
 * MessageActionSheet — modal bottom sheet that appears on long-press of a
 * message bubble in ChatScreen.
 *
 * Actions (OpenChat-uxj, OpenChat-46p, OpenChat-wgl, OpenChat-q9h, OpenChat-7bd, OpenChat-hhc):
 *   Reply         — always shown; sets composer replyTo state
 *   Forward       — always shown (own and others'); opens ForwardPickerScreen
 *   Edit          — own messages only; enters edit mode in composer
 *   Delete        — own messages only; confirms then soft-deletes
 *   React         — always shown; shows inline emoji picker
 *   Block <name>  — others' messages only
 *   Report        — others' messages only; sub-sheet for reason
 */

import { useState } from 'react';
import {
  Alert,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { Message, ReactionSummary } from '../api/client';
import { ReactionPicker } from './ReactionPicker';
import { AppIcon } from './AppIcon';

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
  /**
   * Save the message into the user's Thoughts stream (with provenance).
   * `pin` additionally pins the new thought to this conversation so all
   * participants see it in the chat-scoped Thoughts view.
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
}

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
  onSaveToThoughts,
  onEdit,
  onDelete,
  onReact,
  onBlock,
  onReport,
}: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  // Sub-sheet state: null = main, 'report' = report picker, 'other' = freeform,
  // 'react' = emoji picker, 'assistant' = "ask about this" question prompt.
  const [subSheet, setSubSheet] = useState<null | 'report' | 'other' | 'react' | 'assistant'>(null);
  const [freeformText, setFreeformText] = useState('');
  // Separate state for the assistant-question input so it doesn't collide with
  // the report freeform field.
  const [assistantQuestion, setAssistantQuestion] = useState('');

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

  // Save to Thoughts / Save & pin (unified capture affordance).
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

  const overlayStyle = { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' as const };

  const sheetStyle = [
    styles.sheet,
    {
      backgroundColor: c.surface,
      borderColor: c.border,
      paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    },
  ];

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
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Submit report</Text>
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
              <Text style={[styles.title, { color: c.textPrimary }]}>Ask your assistant about this</Text>
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
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Send to assistant</Text>
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

  // ── Main action sheet ──────────────────────────────────────────────────────
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={handleDismiss}>
      <Pressable style={overlayStyle} onPress={handleDismiss}>
        <Pressable onPress={() => { /* stop propagation */ }}>
          <View style={sheetStyle}>
            <View style={styles.handle} />

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

            {/* Copy — always shown (even for deleted, harmless) (openchat-651) */}
            {!message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleCopy}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>📋</Text>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Copy</Text>
              </TouchableOpacity>
            )}

            {/* Reply — always shown (skip if message is deleted) */}
            {!message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleReply}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>↩</Text>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Reply</Text>
              </TouchableOpacity>
            )}

            {/* Forward — always shown (own and others'), skip if deleted (OpenChat-hhc) */}
            {!message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleForwardPress}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>↪</Text>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Forward</Text>
              </TouchableOpacity>
            )}

            {/* Save to Thoughts / Save & pin — the unified capture affordance.
                Saves this message's text into the user's Thoughts stream with
                provenance; the pin variant also shares it to this chat's
                pinned notes. Skip for messages with no text (e.g. image-only). */}
            {!message.deletedAt && !!message.content?.trim() && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleSaveToThoughts}
                activeOpacity={0.7}
              >
                <View style={styles.actionIconBox}>
                  <AppIcon name="thought" color={c.textPrimary} size={20} />
                </View>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Save to Thoughts</Text>
              </TouchableOpacity>
            )}
            {!message.deletedAt && !!message.content?.trim() && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleSaveAndPin}
                activeOpacity={0.7}
              >
                <View style={styles.actionIconBox}>
                  <AppIcon name="pin" color={c.textPrimary} size={20} />
                </View>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Save & pin to chat</Text>
              </TouchableOpacity>
            )}

            {/* Forward to Assistant — private "ask my agent" (openchat-ug6).
                Always shown (own and others'), skip if deleted. Drops the
                quoted message into the user's PRIVATE Assistant DM — never
                posts back into this shared conversation. */}
            {!message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleForwardToAssistantPress}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>🤖</Text>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Forward to Assistant</Text>
              </TouchableOpacity>
            )}

            {/* Ask about this… — prompts for a question, then forwards both the
                quoted message and the question to the private Assistant DM. */}
            {!message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={() => setSubSheet('assistant')}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>💬</Text>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Ask my agent about this…</Text>
              </TouchableOpacity>
            )}

            {/* Edit — own non-deleted messages only (OpenChat-q9h) */}
            {isOwn && !message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleEditPress}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>✎</Text>
                <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Edit message</Text>
              </TouchableOpacity>
            )}

            {/* Delete — own messages only (OpenChat-q9h) */}
            {isOwn && !message.deletedAt && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleDeletePress}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>🗑</Text>
                <Text style={[styles.actionLabel, { color: c.danger }]}>Delete message</Text>
              </TouchableOpacity>
            )}

            {/* Block — only on others' messages */}
            {!isOwn && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={handleBlockPress}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>🚫</Text>
                <Text style={[styles.actionLabel, { color: c.danger }]}>
                  Block {senderName}
                </Text>
              </TouchableOpacity>
            )}

            {/* Report — only on others' messages */}
            {!isOwn && (
              <TouchableOpacity
                style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
                onPress={() => setSubSheet('report')}
                activeOpacity={0.7}
              >
                <Text style={styles.actionIcon}>⚑</Text>
                <Text style={[styles.actionLabel, { color: c.danger }]}>Report message</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.cancelRow, { borderColor: c.border }]}
              onPress={handleDismiss}
              activeOpacity={0.7}
            >
              <Text style={[styles.cancelLabel, { color: c.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
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
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 14,
  },
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
