/**
 * MessageActionSheet — modal bottom sheet that appears on long-press of a
 * message bubble in ChatScreen.
 *
 * Actions shipped (OpenChat-uxj, OpenChat-46p, OpenChat-wgl):
 *   Reply         — sets composer replyTo state, dismisses sheet
 *   Block <name>  — only on others' messages; confirms then calls api.blockUser
 *   Report        — only on others' messages; sub-sheet for reason then submits
 *
 * Future hooks (Edit, Delete, React) are listed in comments but not rendered.
 */

import { useState } from 'react';
import {
  Alert,
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
import { Message } from '../api/client';

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
  onBlock,
  onReport,
}: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  // Sub-sheet state: null = main, 'report' = report picker, 'other' = freeform
  const [subSheet, setSubSheet] = useState<null | 'report' | 'other'>(null);
  const [freeformText, setFreeformText] = useState('');

  const handleDismiss = () => {
    setSubSheet(null);
    setFreeformText('');
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
                {message.content}
              </Text>
            </View>

            {/* Reply — always shown */}
            <TouchableOpacity
              style={[styles.actionRow, styles.actionRowBorder, { borderColor: c.divider }]}
              onPress={handleReply}
              activeOpacity={0.7}
            >
              <Text style={styles.actionIcon}>↩</Text>
              <Text style={[styles.actionLabel, { color: c.textPrimary }]}>Reply</Text>
            </TouchableOpacity>

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

            {/* Future: Edit own message — hook placeholder, not rendered */}
            {/* Future: Delete own message — hook placeholder, not rendered */}
            {/* Future: React with emoji — hook placeholder, not rendered */}

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
