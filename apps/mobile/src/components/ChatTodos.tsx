/**
 * The To-dos tab of the conversation side panel: the owner's private to-dos
 * for this chat.
 *
 * Everything here is visible to the owner only, and the tab says so in three
 * ways at once (a lock, the words "Only you", and the private tint) so it can
 * never be read as something posted to the conversation.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import { addChatTodo, deleteChatTodo, renameChatTodo, setChatTodoDone, useChatTodos } from '../services/chatTodos';
import { TODO_TEXT_MAX, type ChatTodo } from '../utils/chatTodos';
import { AppIcon } from './AppIcon';

/** True when a to-do's text is just its source message (or the start of it). */
function sameWords(excerpt: string, text: string): boolean {
  const flat = (value: string) => value.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return flat(excerpt).startsWith(flat(text));
}

interface Props {
  conversationId: string;
  /** A to-do to bring into view and mark, e.g. the one just made from a message. */
  focusTodoId?: string;
  /** Jump to the message a to-do was made from. */
  onOpenSource?: (messageId: string) => void;
}

export function ChatTodos({ conversationId, focusTodoId, onOpenSource }: Props) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const { currentUser } = useChat();
  const { open, done, truncated, loading, error, reload } = useChatTodos(currentUser?.userId, conversationId);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (focusTodoId && done.some(todo => todo.id === focusTodoId)) setShowDone(true); }, [focusTodoId, done]);

  const run = async (id: string, work: () => Promise<unknown>) => {
    if (busyId) return;
    setBusyId(id); setFailure(null); setNotice(null);
    try { await work(); }
    catch (err) { if (alive.current) setFailure(err instanceof Error ? err.message : 'That did not save. Try again.'); }
    finally { if (alive.current) setBusyId(null); }
  };

  const add = async () => {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true); setFailure(null); setNotice(null);
    try {
      const result = await addChatTodo({ conversationId, text });
      if (!alive.current) return;
      setDraft('');
      if (!result.created) setNotice('You already had that to-do. It is open again here.');
    } catch (err) {
      if (alive.current) setFailure(err instanceof Error ? err.message : 'That did not save. Your text is still here.');
    } finally {
      if (alive.current) setAdding(false);
    }
  };

  const beginEdit = (todo: ChatTodo) => { setEditingId(todo.id); setEditText(todo.text); };
  const saveEdit = (todo: ChatTodo) => {
    const text = editText.trim();
    if (!text || text === todo.text) { setEditingId(null); return; }
    void run(todo.id, async () => { await renameChatTodo(conversationId, todo.id, text); if (alive.current) setEditingId(null); });
  };

  const row = (todo: ChatTodo) => {
    const editing = editingId === todo.id;
    const busy = busyId === todo.id;
    const focused = focusTodoId === todo.id;
    const source = todo.sources.find(item => item.conversationId === conversationId);
    return (
      <View key={todo.id} style={[styles.row, { borderColor: focused ? r.private : r.line, backgroundColor: focused ? r.privateSoft : r.card }]}>
        <TouchableOpacity
          accessibilityRole="checkbox"
          accessibilityState={{ checked: todo.done, busy }}
          accessibilityLabel={`${todo.done ? 'Reopen' : 'Mark done'}: ${todo.text}`}
          disabled={busy}
          onPress={() => void run(todo.id, () => setChatTodoDone(conversationId, todo.id, !todo.done))}
          style={styles.check}
        >
          {busy ? <ActivityIndicator size="small" color={r.private} /> : <AppIcon name={todo.done ? 'todo' : 'circle'} color={todo.done ? r.textMeta : r.private} size={20} />}
        </TouchableOpacity>
        <View style={styles.rowBody}>
          {editing ? (
            <>
              <TextInput
                accessibilityLabel="To-do text"
                value={editText}
                onChangeText={setEditText}
                autoFocus
                multiline
                maxLength={TODO_TEXT_MAX}
                onSubmitEditing={() => saveEdit(todo)}
                blurOnSubmit
                {...(Platform.OS === 'web' ? { onKeyPress: (event: { nativeEvent: { key: string } }) => { if (event.nativeEvent.key === 'Escape') setEditingId(null); } } : {})}
                style={[type.body, styles.editInput, { color: r.text, backgroundColor: r.input, borderColor: r.line }]}
              />
              <View style={styles.editActions}>
                <TouchableOpacity accessibilityRole="button" onPress={() => saveEdit(todo)} style={styles.textAction}><Text style={[type.label, { color: r.private }]}>Save</Text></TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" onPress={() => setEditingId(null)} style={styles.textAction}><Text style={[type.label, { color: r.textSecondary }]}>Cancel</Text></TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete to-do: ${todo.text}`} onPress={() => void run(todo.id, () => deleteChatTodo(conversationId, todo.id))} style={[styles.textAction, styles.deleteAction]}>
                  <Text style={[type.label, { color: r.danger }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Edit to-do: ${todo.text}`} onPress={() => beginEdit(todo)} style={styles.textButton}>
              <Text style={[type.body, { color: todo.done ? r.textMeta : r.text }, todo.done && styles.struck]}>{todo.text}</Text>
            </TouchableOpacity>
          )}
          {!editing && source && (
            <TouchableOpacity
              accessibilityRole="link"
              accessibilityLabel={`Go to the message this came from: ${source.excerpt}`}
              disabled={!onOpenSource}
              onPress={() => onOpenSource?.(source.messageId)}
              style={[styles.source, { borderLeftColor: r.line }]}
            >
              {/* A to-do made in one press carries the message's own words; repeating them as a quote says nothing. */}
              <Text style={[type.meta, { color: r.textMeta }]} numberOfLines={2}>{sameWords(source.excerpt, todo.text) ? 'From a message in this chat' : source.excerpt}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={[styles.banner, { backgroundColor: r.privateSoft }]} accessibilityRole="text">
        <AppIcon name="lock" color={r.private} size={14} strokeWidth={2.2} />
        <Text style={[type.label, styles.bannerText, { color: r.text }]}>
          <Text style={{ color: r.private, fontWeight: '700' }}>Only you</Text> can see these. Nothing here is sent to the chat.
        </Text>
      </View>

      <View style={[styles.addRow, { borderColor: r.private, backgroundColor: r.card }]}>
        <AppIcon name="plus" color={r.private} size={18} />
        <TextInput
          accessibilityLabel="Add a private to-do"
          placeholder="Add a private to-do…"
          placeholderTextColor={r.decoration}
          value={draft}
          onChangeText={setDraft}
          maxLength={TODO_TEXT_MAX}
          editable={!adding}
          onSubmitEditing={() => void add()}
          returnKeyType="done"
          blurOnSubmit={false}
          style={[type.body, styles.addInput, { color: r.text }]}
        />
        {adding
          ? <ActivityIndicator size="small" color={r.private} />
          : !!draft.trim() && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add to-do" onPress={() => void add()} style={styles.addButton}>
              <Text style={[type.label, { color: r.private, fontWeight: '700' }]}>Add</Text>
            </TouchableOpacity>
          )}
      </View>

      {(failure || error) && (
        <View style={styles.message}>
          <Text accessibilityRole="alert" style={[type.meta, { color: r.danger }]}>{failure || error}</Text>
          {!failure && error ? <TouchableOpacity accessibilityRole="button" onPress={() => void reload()} style={styles.textAction}><Text style={[type.label, { color: r.private }]}>Retry</Text></TouchableOpacity> : null}
        </View>
      )}
      {notice && <Text accessibilityLiveRegion="polite" style={[type.meta, styles.message, { color: r.textMeta }]}>{notice}</Text>}

      {loading && !open.length && !done.length ? <ActivityIndicator color={r.private} style={styles.spinner} /> : null}
      {!loading && !error && !open.length && !done.length && (
        <View style={styles.empty}>
          <Text style={[type.bodyStrong, { color: r.text }]}>Nothing to do here yet</Text>
          <Text style={[type.label, styles.emptyText, { color: r.textSecondary }]}>
            Note what you mean to do after this chat, like introducing two people. Add one above, type /todo in the message box, or use To-do on any message.
          </Text>
        </View>
      )}

      {open.map(row)}

      {done.length > 0 && (
        <>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: showDone }} onPress={() => setShowDone(value => !value)} style={styles.doneToggle}>
            <AppIcon name={showDone ? 'chevron-down' : 'chevron-right'} color={r.textMeta} size={14} />
            <Text style={[type.label, { color: r.textMeta }]}>Done · {done.length}</Text>
          </TouchableOpacity>
          {showDone && done.map(row)}
        </>
      )}
      {truncated && <Text style={[type.meta, styles.message, { color: r.textMeta }]}>Showing your 200 most current asks. Older finished to-dos may be missing here; the Asks tab has them all.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space[3], paddingBottom: space[8], gap: space[2] },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2], borderRadius: radius.md },
  bannerText: { flex: 1, minWidth: 0, fontWeight: '400' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: touchTarget, paddingLeft: space[3], paddingRight: space[1], borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.md },
  addInput: { flex: 1, minWidth: 0, minHeight: touchTarget, paddingVertical: 0 },
  addButton: { minHeight: touchTarget, paddingHorizontal: space[3], justifyContent: 'center' },
  message: { paddingHorizontal: space[1] },
  spinner: { marginVertical: space[4] },
  empty: { paddingHorizontal: space[1], paddingVertical: space[4], gap: space[1] },
  emptyText: { fontWeight: '400' },
  row: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingRight: space[3] },
  check: { width: touchTarget, minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: space[2], gap: space[1] },
  textButton: { minHeight: touchTarget - space[4], justifyContent: 'center' },
  struck: { textDecorationLine: 'line-through' },
  source: { borderLeftWidth: 2, paddingLeft: space[2], paddingVertical: 2 },
  editInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space[2], paddingVertical: space[2], minHeight: touchTarget },
  editActions: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  textAction: { minHeight: touchTarget, paddingHorizontal: space[2], justifyContent: 'center' },
  deleteAction: { marginLeft: 'auto' },
  doneToggle: { flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: touchTarget, paddingHorizontal: space[1], marginTop: space[2] },
});
