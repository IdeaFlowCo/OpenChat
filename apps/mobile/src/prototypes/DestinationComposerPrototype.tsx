import { randomUUID } from 'expo-crypto';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api, Conversation, CurrentUser, Thought } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { createThought } from '../services/thoughts';
import { getColors } from '../theme/colors';

const STREAM_TARGET = 'thought-stream-root';

function conversationTitle(conversation: Conversation, currentUser: CurrentUser | null): string {
  if (conversation.title) return conversation.title;
  if (conversation.type === 'direct') {
    const other = conversation.participants?.find(
      (participant) => participant.user.id !== currentUser?.userId
    )?.user;
    return other?.name || other?.email || 'Direct message';
  }

  const others = (conversation.participants || [])
    .filter((participant) => participant.user.id !== currentUser?.userId)
    .map((participant) => participant.user.name || participant.user.email.split('@')[0]);
  if (!others.length) return 'Group';
  return others.length > 2 ? `${others[0]}, ${others[1]} +${others.length - 2}` : others.join(', ');
}

function audienceLabel(conversation: Conversation, currentUser: CurrentUser | null): string {
  if (conversation.type === 'group') {
    const participantCount = conversation.participants?.length ?? 0;
    return `Group · ${participantCount || 'several'} people`;
  }
  const other = conversation.participants?.find(
    (participant) => participant.user.id !== currentUser?.userId
  )?.user;
  return `Direct · You and ${other?.name || other?.email || 'one person'}`;
}

export function ThoughtStreamLensBar({
  onOpenConversation,
}: {
  onOpenConversation: (conversationId: string) => void;
}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const {
    conversations,
    conversationsLoaded,
    currentUser,
    refreshConversations,
  } = useChat();

  useEffect(() => {
    if (!conversationsLoaded) void refreshConversations();
  }, [conversationsLoaded, refreshConversations]);

  return (
    <View style={[styles.streamHeader, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.streamTitleRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.eyebrow, { color: c.primary }]}>ROOT CONTEXT</Text>
          <Text style={[styles.streamTitle, { color: c.textPrimary }]}>Thought Stream</Text>
        </View>
        <View style={[styles.privateLabel, { backgroundColor: c.surfaceElevated }]}>
          <View style={[styles.audienceDot, { backgroundColor: c.presenceAvailable }]} />
          <Text style={[styles.privateLabelText, { color: c.textSecondary }]}>Only you</Text>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.lensRow}
      >
        <View style={[styles.activeLens, { backgroundColor: c.primaryMuted, borderColor: c.primary }]}>
          <Text style={[styles.lensKind, { color: c.primary }]}>STREAM</Text>
          <Text style={[styles.lensName, { color: c.textPrimary }]}>My thoughts</Text>
        </View>
        {conversations.map((conversation) => (
          <Pressable
            key={conversation.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${conversationTitle(conversation, currentUser)} chat lens`}
            onPress={() => onOpenConversation(conversation.id)}
            style={({ pressed }) => [
              styles.lensButton,
              { borderColor: c.border, backgroundColor: c.background },
              pressed && { opacity: 0.68 },
            ]}
          >
            <Text
              style={[
                styles.lensKind,
                { color: conversation.type === 'group' ? '#b45309' : c.textMuted },
              ]}
            >
              {conversation.type === 'group' ? 'GROUP' : 'DIRECT'}
            </Text>
            <Text style={[styles.lensName, { color: c.textPrimary }]} numberOfLines={1}>
              {conversationTitle(conversation, currentUser)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export function DestinationComposerPrototype({
  onThoughtCreated,
}: {
  onThoughtCreated: (thought: Thought) => void;
}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const {
    conversations,
    currentUser,
    isConnected,
    refreshConversations,
  } = useChat();
  const [selectedIds, setSelectedIds] = useState<string[]>([STREAM_TARGET]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const selectedConversations = useMemo(
    () => conversations.filter((conversation) => selectedIds.includes(conversation.id)),
    [conversations, selectedIds]
  );
  const includesStream = selectedIds.includes(STREAM_TARGET);

  const destinationSummary = useMemo(() => {
    const count = selectedConversations.length + (includesStream ? 1 : 0);
    if (count > 1) return `${count} destinations`;
    if (includesStream) return 'My Thought Stream';
    if (selectedConversations[0]) return conversationTitle(selectedConversations[0], currentUser);
    return 'Choose destination';
  }, [currentUser, includesStream, selectedConversations]);

  const consequence = useMemo(() => {
    if (includesStream && selectedConversations.length) {
      return `Private thought + ${selectedConversations.length} separate ${selectedConversations.length === 1 ? 'message' : 'messages'}`;
    }
    if (includesStream) return 'Private · Only you';
    if (selectedConversations.length === 1) {
      return audienceLabel(selectedConversations[0], currentUser);
    }
    return `${selectedConversations.length} separate chats`;
  }, [currentUser, includesStream, selectedConversations]);

  const toggleDestination = (id: string) => {
    setResult(null);
    setSelectedIds((current) => {
      if (current.includes(id)) {
        return current.length === 1 ? current : current.filter((targetId) => targetId !== id);
      }
      return [...current, id];
    });
  };

  const publish = async () => {
    const body = text.trim();
    if (!body || sending || !isConnected) return;
    setSending(true);
    setResult(null);

    let createdThought: Thought | null = null;
    const outcomes: boolean[] = [];

    if (includesStream) {
      try {
        createdThought = await createThought({ text: body, kind: 'observation', status: 'none' });
        outcomes.push(true);
      } catch {
        outcomes.push(false);
      }
    }

    const messageOutcomes = await Promise.all(
      selectedConversations.map(async (conversation) => {
        try {
          await api.sendMessage(conversation.id, body, undefined, randomUUID());
          return true;
        } catch {
          return false;
        }
      })
    );
    outcomes.push(...messageOutcomes);

    if (createdThought) onThoughtCreated(createdThought);
    if (messageOutcomes.some(Boolean)) void refreshConversations();

    const successful = outcomes.filter(Boolean).length;
    if (successful > 0) setText('');
    if (successful === outcomes.length) {
      setResult(`Delivered to ${successful} ${successful === 1 ? 'destination' : 'destinations'}`);
    } else {
      setResult(`${successful} of ${outcomes.length} destinations received this`);
    }
    setSending(false);
  };

  return (
    <>
      <View style={[styles.composerWrap, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.destinationRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose message destinations"
            onPress={() => setPickerOpen(true)}
            style={({ pressed }) => [
              styles.destinationButton,
              { backgroundColor: c.surfaceElevated, borderColor: c.border },
              pressed && { opacity: 0.72 },
            ]}
          >
            <Text style={[styles.toLabel, { color: c.textMuted }]}>TO</Text>
            <Text style={[styles.destinationName, { color: c.textPrimary }]} numberOfLines={1}>
              {destinationSummary}
            </Text>
            <Text style={[styles.chevron, { color: c.textSecondary }]}>⌄</Text>
          </Pressable>
          <Text style={[styles.consequence, { color: c.textSecondary }]} numberOfLines={2}>
            {consequence}
          </Text>
        </View>

        <View style={styles.composerBody}>
          <TextInput
            multiline
            value={text}
            onChangeText={(value) => { setText(value); setResult(null); }}
            placeholder={includesStream && !selectedConversations.length
              ? 'Capture what you are thinking…'
              : 'Write once, choose who receives it…'}
            placeholderTextColor={c.textMuted}
            style={[
              styles.composerInput,
              { backgroundColor: c.background, borderColor: c.border, color: c.textPrimary },
            ]}
            textAlignVertical="top"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Publish to selected destinations"
            disabled={!text.trim() || sending || !isConnected}
            onPress={() => void publish()}
            style={({ pressed }) => [
              styles.sendButton,
              { backgroundColor: c.primary },
              (!text.trim() || sending || !isConnected) && styles.sendButtonDisabled,
              pressed && { backgroundColor: c.primaryActive },
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendButtonText}>↑</Text>
            )}
          </Pressable>
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusText, { color: result ? c.primary : c.textMuted }]} numberOfLines={1}>
            {result || (isConnected ? 'Draft stays here while you choose audiences' : 'Offline · publishing unavailable')}
          </Text>
          <Text style={[styles.audienceCount, { color: c.textMuted }]}>{text.length}</Text>
        </View>
      </View>

      <Modal
        animationType="fade"
        transparent
        visible={pickerOpen}
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setPickerOpen(false)}>
          <Pressable
            accessibilityRole="menu"
            onPress={() => undefined}
            style={[styles.picker, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <View style={styles.pickerHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.eyebrow, { color: c.primary }]}>AUDIENCE</Text>
                <Text style={[styles.pickerTitle, { color: c.textPrimary }]}>Choose one or more destinations</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close destination picker"
                onPress={() => setPickerOpen(false)}
                style={styles.closeButton}
              >
                <Text style={[styles.closeText, { color: c.textSecondary }]}>×</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.optionList} contentContainerStyle={{ paddingBottom: 8 }}>
              <DestinationOption
                title="My Thought Stream"
                detail="Private · Only you"
                selected={includesStream}
                onPress={() => toggleDestination(STREAM_TARGET)}
                colors={c}
              />
              {conversations.map((conversation) => (
                <DestinationOption
                  key={conversation.id}
                  title={conversationTitle(conversation, currentUser)}
                  detail={audienceLabel(conversation, currentUser)}
                  selected={selectedIds.includes(conversation.id)}
                  onPress={() => toggleDestination(conversation.id)}
                  colors={c}
                />
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(false)}
              style={[styles.doneButton, { backgroundColor: c.primary }]}
            >
              <Text style={styles.doneButtonText}>Done · {selectedIds.length} selected</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function DestinationOption({
  title,
  detail,
  selected,
  onPress,
  colors,
}: {
  title: string;
  detail: string;
  selected: boolean;
  onPress: () => void;
  colors: ReturnType<typeof getColors>;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        { borderColor: colors.divider },
        selected && { backgroundColor: colors.primaryMuted },
        pressed && { opacity: 0.72 },
      ]}
    >
      <View
        style={[
          styles.checkbox,
          { borderColor: selected ? colors.primary : colors.textMuted },
          selected && { backgroundColor: colors.primary },
        ]}
      >
        {selected ? <Text style={styles.checkmark}>✓</Text> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.optionTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.optionDetail, { color: colors.textSecondary }]} numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  streamHeader: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
  },
  streamTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 0 },
  streamTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700', marginTop: 2 },
  privateLabel: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  audienceDot: { width: 7, height: 7, borderRadius: 4 },
  privateLabelText: { fontSize: 12, fontWeight: '600' },
  lensRow: { gap: 8, paddingTop: 12, paddingRight: 12 },
  activeLens: {
    width: 128,
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  lensButton: {
    width: 148,
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  lensKind: { fontSize: 9, fontWeight: '800', letterSpacing: 0 },
  lensName: { fontSize: 13, fontWeight: '600', marginTop: 3 },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
  },
  destinationRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  destinationButton: {
    minHeight: 36,
    maxWidth: '58%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  toLabel: { fontSize: 9, fontWeight: '800' },
  destinationName: { flexShrink: 1, fontSize: 13, fontWeight: '700' },
  chevron: { fontSize: 15, marginLeft: 'auto' },
  consequence: { flex: 1, fontSize: 11, lineHeight: 15, textAlign: 'right' },
  composerBody: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  composerInput: {
    flex: 1,
    minHeight: 52,
    maxHeight: 112,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    lineHeight: 21,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.36 },
  sendButtonText: { color: '#fff', fontSize: 22, lineHeight: 24, fontWeight: '700' },
  statusRow: { minHeight: 18, flexDirection: 'row', alignItems: 'center', marginTop: 5, gap: 8 },
  statusText: { flex: 1, fontSize: 10, fontWeight: '600' },
  audienceCount: { fontSize: 10 },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.46)',
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  picker: {
    maxHeight: '78%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 14,
  },
  pickerHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  pickerTitle: { fontSize: 18, lineHeight: 24, fontWeight: '700', marginTop: 3 },
  closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 28, lineHeight: 30 },
  optionList: { flexGrow: 0 },
  option: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { color: '#fff', fontSize: 14, lineHeight: 16, fontWeight: '800' },
  optionTitle: { fontSize: 14, fontWeight: '600' },
  optionDetail: { fontSize: 11, marginTop: 3 },
  doneButton: { minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  doneButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
