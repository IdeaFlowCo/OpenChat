/**
 * The conversation side panel: what you keep about a chat, beside the chat.
 *
 *   To-dos   your private to-dos for this chat (owner-only)
 *   Stream   notes and messages saved or pinned here (the chat's Stream)
 *   Details  the person, or the group and its members
 *
 * The same component is the docked third column on wide screens, the drawer
 * over the chat on mid-width screens, and a pushed screen on phones.
 */
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import { CONVERSATION_PANEL_TABS, requestMessageJump, type ConversationPanelTab } from '../services/conversationPanel';
import { AppIcon } from './AppIcon';
import { ChatTodos } from './ChatTodos';
import { ContextLane } from './ContextLane';
import { ConversationDetails } from './ConversationDetails';

interface Props {
  conversationId: string;
  tab: ConversationPanelTab;
  onTabChange: (tab: ConversationPanelTab) => void;
  /** Omit where the surrounding screen already has a way back (the phone screen). */
  onClose?: () => void;
  focusTodoId?: string;
  /** Called after a to-do's source message was requested, so a drawer or screen can get out of the way. */
  onOpenedSource?: () => void;
}

export function ConversationPanel({ conversationId, tab, onTabChange, onClose, focusTodoId, onOpenedSource }: Props) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  return (
    <View style={[styles.root, { backgroundColor: r.canvas }]} accessibilityLabel="Conversation panel">
      <View style={[styles.header, { borderBottomColor: r.line, backgroundColor: r.card }]}>
        <View accessibilityRole="tablist" style={styles.tabs}>
          {CONVERSATION_PANEL_TABS.map(item => {
            const selected = item.id === tab;
            return (
              <TouchableOpacity
                key={item.id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={item.id === 'todos' ? 'To-dos, private to you' : item.label}
                onPress={() => onTabChange(item.id)}
                style={[styles.tab, selected && { backgroundColor: r.pressed }]}
              >
                {item.id === 'todos' && <AppIcon name="lock" color={selected ? r.private : r.textMeta} size={12} strokeWidth={2.4} />}
                <Text style={[type.label, { color: selected ? r.text : r.textSecondary, fontWeight: selected ? '600' : '500' }]}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {onClose && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Hide panel"
            onPress={onClose}
            style={styles.close}
            {...(Platform.OS === 'web' ? { title: 'Hide panel (⌘⇧I)' } as object : {})}
          >
            <AppIcon name="x" color={r.textSecondary} size={18} />
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.body}>
        {tab === 'todos' && (
          <ChatTodos
            conversationId={conversationId}
            focusTodoId={focusTodoId}
            onOpenSource={messageId => { requestMessageJump(conversationId, messageId); onOpenedSource?.(); }}
          />
        )}
        {tab === 'stream' && <ContextLane conversationId={conversationId} />}
        {tab === 'details' && <ConversationDetails conversationId={conversationId} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingLeft: space[2], paddingRight: space[1], borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space[1] },
  tab: { minHeight: 32, paddingHorizontal: space[3], borderRadius: radius.sm, flexDirection: 'row', alignItems: 'center', gap: space[1] + 1, justifyContent: 'center' },
  close: { width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minHeight: 0 },
});
