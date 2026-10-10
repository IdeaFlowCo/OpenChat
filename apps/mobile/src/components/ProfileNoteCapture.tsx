/** Lossless private capture: saving succeeds independently of AI review. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api, type PrivateNote, type PrivateSubject, type ProfileNoteReview, type ProfileNoteSuggestion, type ProfileNoteEdit, type PrivateAsk } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
const drafts = new Map<string, string>();
function readDraft(key: string) { try { return Platform.OS === 'web' ? globalThis.sessionStorage?.getItem(key) ?? drafts.get(key) ?? '' : drafts.get(key) ?? ''; } catch { return drafts.get(key) ?? ''; } }
function writeDraft(key: string, value: string) { drafts.set(key, value); try { if (Platform.OS === 'web') globalThis.sessionStorage?.setItem(key, value); } catch { /* Memory draft remains available. */ } }

export function ProfileNoteCapture({ subject, onChange, onAskAgent, sharedAsks, notes = [] }: { subject: PrivateSubject; onChange: () => void; onAskAgent?: () => void; sharedAsks?: ReactNode; notes?: PrivateNote[] }) {
  const { currentUser } = useChat();
  const { scheme } = useTheme(); const c = getColors(scheme);
  const key = `openchat-profile-draft:${currentUser?.userId ?? "signed-out"}:${subject.kind}:${subject.id}`;
  const [stateKey, setStateKey] = useState(key);
  const [draft, setDraft] = useState(() => readDraft(key));
  const [addingAsk, setAddingAsk] = useState(false);
  const [askDraft, setAskDraft] = useState(() => readDraft(`${key}:ask`));
  const askRequest = useRef<string | null>(readDraft(`${key}:ask-request`) || null);
  const [reviews, setReviews] = useState<ProfileNoteReview[]>([]);
  const [asks, setAsks] = useState<PrivateAsk[]>([]);
  const [current, setCurrent] = useState<ProfileNoteReview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [edits, setEdits] = useState<Record<string, ProfileNoteSuggestion>>({});
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const input = useRef<TextInput>(null); const firstEdit = useRef<TextInput>(null);
  const scope = useRef({ key, generation: 0 });
  if (scope.current.key !== key) scope.current = { key, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const isActive = () => scope.current.key === key && scope.current.generation === generation;
  useEffect(() => () => { scope.current.generation += 1; }, []);
  const requestId = useRef<string | null>(null);
  const announce = (text: string) => { setMessage(text); AccessibilityInfo.announceForAccessibility?.(text); };
  const load = async () => { const result = await api.getProfileNoteReviews(subject); if (isActive()) { setReviews(result.reviews); setAsks(result.asks); } };
  useEffect(() => { setStateKey(key); setAddingAsk(false); setAskDraft(readDraft(`${key}:ask`)); askRequest.current = readDraft(`${key}:ask-request`) || null; setDraft(readDraft(key)); setReviews([]); setAsks([]); setCurrent(null); setMessage(''); setError(''); setBusy(false); requestId.current = readDraft(`${key}:request`) || null; void load().catch(() => { if (isActive()) setError('Saved reviews unavailable. Your draft is still here.'); }); }, [key]);
  const updateDraft = (value: string) => { setDraft(value); writeDraft(key, value); requestId.current = null; writeDraft(`${key}:request`, ''); };
  const review = async (saved: ProfileNoteReview) => {
    setBusy(true); setError(''); announce('Note saved. Reviewing possible updates…');
    try {
      const result = await api.suggestProfileNoteReview(saved.id); if (!isActive()) return;
      if (result.status === 'failed' || result.status === 'unavailable') { setError('Your note is saved. Suggestions are unavailable right now. Try reviewing this note again later.'); await load(); return; }
      setCurrent(result); setSelected(result.suggestions.filter(s => !s.duplicate && !s.similar).map(s => s.id)); setEdits(Object.fromEntries(result.suggestions.map(s => [s.id, s])));
      announce(result.suggestions.length ? `${result.suggestions.length} suggestions ready. Edit and select the updates to keep.` : 'Note saved. No updates suggested.');
      setTimeout(() => { if (isActive()) firstEdit.current?.focus(); }, 0); await load();
    } catch { if (isActive()) setError('Your note is saved. Suggestions failed; review the saved note again when ready.'); }
    finally { if (isActive()) setBusy(false); }
  };
  const openReview = (saved: ProfileNoteReview) => {
    setCurrent(saved); setSelected(saved.suggestions.filter(s => !s.duplicate && !s.similar).map(s => s.id));
    setEdits(Object.fromEntries(saved.suggestions.map(s => [s.id, s])));
    setTimeout(() => { if (isActive()) firstEdit.current?.focus(); }, 0);
  };
  const saveAsk = async () => {
    if (!askDraft.trim() || busy) return; setBusy(true); setError('');
    askRequest.current ??= `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeDraft(`${key}:ask-request`, askRequest.current);
    let saved: ProfileNoteReview | null = null;
    try {
      saved = await api.createPrivateAskReview(subject, askDraft, askRequest.current); if (!isActive()) return;
      setReviews(rows => [saved!, ...rows.filter(row => row.id !== saved!.id)]);
      const newSuggestions = saved.suggestions.filter(s => !s.duplicate).map(s => s.id);
      if (!newSuggestions.length) {
        setAskDraft(''); writeDraft(`${key}:ask`, ''); writeDraft(`${key}:ask-request`, ''); askRequest.current = null;
        setAddingAsk(false); await load(); if (!isActive()) return; onChange(); announce('Already recorded. Your source note is saved; no duplicate ask was added.'); return;
      }
      // The user explicitly chose Save privately; this path never asks AI to extract.
      await api.applyProfileNoteReview(saved.id, newSuggestions); if (!isActive()) return;
      setAskDraft(''); writeDraft(`${key}:ask`, ''); writeDraft(`${key}:ask-request`, ''); askRequest.current = null;
      setAddingAsk(false); await load(); if (!isActive()) return; onChange(); announce('Standing ask saved privately. Recorded by you.');
    } catch {
      if (!isActive()) return;
      if (saved) { openReview(saved); setError('Your ask text is saved. Could not add the standing ask; review and apply the saved update below.'); }
      else setError('Ask not saved. Your ask draft is preserved. Try Save privately again.');
    } finally { if (isActive()) setBusy(false); }
  };
  const save = async (withReview: boolean) => {
    if (!draft.trim() || busy) return; setBusy(true); setError('');
    requestId.current ??= `note-${Date.now()}-${Math.random().toString(36).slice(2)}`; writeDraft(`${key}:request`, requestId.current);
    try {
      const saved = await api.createProfileNoteReview(subject, draft, requestId.current); if (!isActive()) return;
      updateDraft(''); setReviews(rows => [saved, ...rows.filter(row => row.id !== saved.id)]); onChange(); announce('Private note saved in your original words.'); input.current?.focus();
      if (withReview) await review(saved);
    } catch { if (isActive()) setError('Note not saved. Your draft is preserved. Try Save note again.'); }
    finally { if (isActive()) setBusy(false); }
  };
  const apply = async () => {
    if (!current || busy || !selected.length) return; setBusy(true); setError('');
    try {
      const changes: ProfileNoteEdit[] = selected.map(id => ({ id, text: edits[id]?.text, relation: edits[id]?.relation, target: edits[id]?.target }));
      await api.applyProfileNoteReview(current.id, selected, changes); if (!isActive()) return;
      setCurrent(null); await load(); if (!isActive()) return; onChange(); announce('Selected updates saved. Undo is available below.'); input.current?.focus();
    } catch { if (isActive()) setError('Could not apply updates. Your saved note and suggestions are preserved.'); }
    finally { if (isActive()) setBusy(false); }
  };
  const undo = async (id: string) => { setBusy(true); setError(''); try { await api.undoProfileNoteReview(id); if (!isActive()) return; await load(); if (!isActive()) return; onChange(); announce('Imported updates undone. Original note kept.'); } catch (failure) { if (isActive()) setError(failure instanceof Error && failure.message.includes('409') ? 'An imported ask was edited afterward. Undo is unavailable because it would erase that edit.' : 'Could not undo these updates. Try again.'); } finally { if (isActive()) setBusy(false); } };
  const changeAsk = async (id: string, status: PrivateAsk['status']) => {
    if (busy) return; setBusy(true); setError('');
    try { await api.updatePrivateAsk(id, status); if (!isActive()) return; await load(); if (!isActive()) return; announce(`Ask ${status}.`); }
    catch { if (isActive()) setError('Could not update this ask. Try again.'); }
    finally { if (isActive()) setBusy(false); }
  };
  const deleteNote = async (noteId: string) => {
    if (busy) return; setBusy(true); setError('');
    try { await api.deletePrivateNote(noteId); if (!isActive()) return; setCurrent(null); await load(); if (!isActive()) return; onChange(); announce('Note deleted. Applied updates can still be undone.'); }
    catch { if (isActive()) setError('Could not delete note. Try again.'); }
    finally { if (isActive()) setBusy(false); }
  };
  const button = (label: string, action: () => void, disabled = busy, primary = false) => <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={action} style={[styles.button, { borderColor: c.border, backgroundColor: primary ? c.primary : c.surfaceElevated, opacity: disabled ? 0.5 : 1 }]}><Text style={{ color: primary ? c.onPrimary : c.textPrimary, fontWeight: '600' }}>{label}</Text></TouchableOpacity>;
  const field = { color: c.textPrimary, borderColor: c.border, backgroundColor: c.background };
  if (stateKey !== key) return <Text style={{ color: c.textMetadata }}>Loading your private notes…</Text>;
  return <View style={styles.root}>
    <View style={styles.row}><Text style={[styles.heading, { color: c.textPrimary }]}>Capture a private note</Text>{onAskAgent && button('Ask agent', onAskAgent, false)}</View>
    <TextInput ref={input} accessibilityLabel="Private rough note" value={draft} onChangeText={updateDraft} multiline maxLength={4000} editable={!busy} placeholder="What did you learn or want to remember?" placeholderTextColor={c.textMuted} style={[styles.input, styles.note, field]}
      onKeyPress={event => { if (Platform.OS !== 'web') return; const e = event.nativeEvent as unknown as { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; preventDefault?: () => void }; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { event.preventDefault(); void save(!!e.shiftKey); } }} />
    <View style={styles.row}>{button(busy ? 'Working…' : 'Save note', () => void save(false), busy || !draft.trim(), true)}{button('Save & review updates', () => void save(true), busy || !draft.trim())}</View>
    {Platform.OS === 'web' && <Text style={{ color: c.textMetadata, fontSize: 12 }}>Cmd/Ctrl+Enter to save · Shift+Cmd/Ctrl+Enter to review updates</Text>}
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: c.textMetadata }}>{message}</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text>}
    {current && current.suggestions.length > 0 && <View style={[styles.review, { borderColor: c.border }]}>
      <Text style={[styles.heading, { color: c.textPrimary }]}>Review proposed updates</Text>
      <Text style={{ color: c.textMetadata, fontSize: 13 }}>Only selected updates are added. These are your private observations, not verified claims.</Text>
      {current.suggestions.map((s, index) => { const edit = edits[s.id] ?? s; const patch = (value: Partial<ProfileNoteSuggestion>) => setEdits(rows => ({ ...rows, [s.id]: { ...edit, ...value } })); return <View key={s.id} style={[styles.proposal, { borderColor: c.divider }]}>
        <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(s.id), disabled: !!s.duplicate || busy }} disabled={s.duplicate || busy} onPress={() => setSelected(ids => ids.includes(s.id) ? ids.filter(id => id !== s.id) : [...ids, s.id])} style={styles.select}><Text style={{ color: c.textPrimary, fontWeight: '600' }}>{selected.includes(s.id) ? '☑' : '☐'} {s.kind === 'ask' ? 'Standing ask' : 'Connection'}{s.duplicate ? ' · Already recorded — skipped' : s.similar ? ' · Similar ask — review carefully' : ''}</Text></TouchableOpacity>
        {s.kind === 'ask' ? <TextInput ref={index === 0 ? firstEdit : undefined} accessibilityLabel={`Edit standing ask ${index + 1}`} multiline value={edit.text} onChangeText={text => patch({ text })} editable={!busy && !s.duplicate} style={[styles.input, field]} /> : <>
          <TextInput ref={index === 0 ? firstEdit : undefined} accessibilityLabel={`Relation for suggestion ${index + 1}`} value={edit.relation ?? ''} onChangeText={relation => patch({ relation })} editable={!busy && !s.duplicate} style={[styles.input, field]} />
          {edit.target?.kind === 'person' && <Text style={{ color: c.textMetadata, fontSize: 12 }}>A private person record. This does not create or verify an OpenChat account.</Text>}
          <TextInput accessibilityLabel={`Target name for suggestion ${index + 1}`} value={edit.target?.name ?? ''} onChangeText={name => patch({ target: { kind: edit.target?.kind ?? 'idea', name } })} editable={!busy && !s.duplicate} style={[styles.input, field]} />
          <View style={styles.row}>{(['person','company','project','idea'] as const).map(kind => <TouchableOpacity key={kind} accessibilityRole="radio" accessibilityState={{ checked: edit.target?.kind === kind }} disabled={busy || s.duplicate} onPress={() => patch({ target: { name: edit.target?.name ?? '', kind } })} style={[styles.button, { borderColor: c.border, backgroundColor: edit.target?.kind === kind ? c.primary : c.surface }]}><Text style={{ color: edit.target?.kind === kind ? c.onPrimary : c.textPrimary }}>{kind}</Text></TouchableOpacity>)}</View>
        </>}
        <Text style={{ color: c.textMetadata, fontSize: 12 }}>From your note: {s.evidence}</Text>
      </View>; })}
      <View style={styles.row}>{button(`Apply selected (${selected.length})`, () => void apply(), busy || !selected.length, true)}{button('Close review', () => { setCurrent(null); input.current?.focus(); })}</View>
    </View>}
    <View style={styles.row}><Text style={[styles.heading, { color: c.textPrimary }]}>Asks</Text>{button(addingAsk ? "Cancel add ask" : "+ Add ask", () => setAddingAsk(value => !value))}</View>
    {addingAsk && <View style={[styles.review, { borderColor: c.border }]}><Text style={{ color: c.textMetadata, fontSize: 13 }}>Only you can see this ask. Recorded by you.</Text><TextInput accessibilityLabel="New private standing ask" value={askDraft} onChangeText={value => { setAskDraft(value); writeDraft(`${key}:ask`, value); askRequest.current = null; writeDraft(`${key}:ask-request`, ""); }} multiline maxLength={500} editable={!busy} style={[styles.input, field]} placeholder="What are they looking for?" placeholderTextColor={c.textMuted} /><View style={styles.row}>{button("Save privately", () => void saveAsk(), busy || !askDraft.trim(), true)}{button("Cancel", () => setAddingAsk(false))}</View></View>}
    {asks.map(ask => <View key={ask.id} style={styles.proposal}><Text style={{ color: c.textPrimary }}>{ask.text}</Text><Text style={{ color: c.textMetadata, fontSize: 12 }}>Only me · Recorded by you · {ask.status} · {new Date(ask.createdAt).toLocaleDateString()}</Text><View style={styles.row}>{button(`Source for ask`, () => setSourceId(sourceId === ask.sourceNoteId ? null : ask.sourceNoteId), false)}{button(ask.status === 'active' ? 'Pause ask' : 'Activate ask', () => void changeAsk(ask.id, ask.status === 'active' ? 'paused' : 'active'))}{ask.status !== 'closed' && button('Close ask', () => void changeAsk(ask.id, 'closed'))}</View>{sourceId === ask.sourceNoteId && <Text style={{ color: c.textPrimary, lineHeight: 21 }}>{reviews.find(r => r.note.id === ask.sourceNoteId && r.sourceNoteAvailable !== false)?.note.text ?? notes.find(n => n.id === ask.sourceNoteId)?.text ?? 'Original note unavailable.'}</Text>}</View>)}
    {sharedAsks}
    {notes.length > 0 && <Text style={[styles.heading, { color: c.textPrimary }]}>Saved notes</Text>}
    {notes.filter(note => !reviews.some(review => review.note.id === note.id)).map(note => <View key={note.id} style={[styles.proposal, { borderColor: c.divider }]}><Text style={{ color: c.textMetadata, fontSize: 12 }}>{new Date(note.createdAt).toLocaleDateString()}</Text><Text style={{ color: c.textPrimary, lineHeight: 21 }}>{note.text}</Text>{button("Delete note", () => void deleteNote(note.id))}</View>)}
    {reviews.map(r => <View key={r.id} style={[styles.proposal, { borderColor: c.divider }]}>
      <Text style={{ color: c.textMetadata, fontSize: 12 }}>Saved note · {new Date(r.note.createdAt).toLocaleDateString()}</Text>
      <Text style={{ color: c.textPrimary, lineHeight: 21 }}>{r.sourceNoteAvailable === false ? 'Original note deleted.' : r.note.text}</Text>
      <View style={styles.row}>{r.status === 'applied' ? button(`Undo imported updates (${(r.createdRecords?.length ?? r.appliedIds.length)})`, () => void undo(r.id)) : r.status !== 'undone' && r.sourceNoteAvailable !== false && button('Review updates from this note', () => r.status === 'ready' ? openReview(r) : void review(r))}{r.sourceNoteAvailable !== false && button('Delete note', () => void deleteNote(r.note.id))}</View>
      {r.status === 'undone' && <Text style={{ color: c.textMetadata, fontSize: 12 }}>Updates undone · Original note kept</Text>}
    </View>)}
  </View>;
}
const styles = StyleSheet.create({ root: { gap: 12 }, heading: { fontSize: 16, fontWeight: '600' }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }, input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, minHeight: 44, fontSize: 15 }, note: { minHeight: 104, textAlignVertical: 'top' }, button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center' }, review: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, gap: 12 }, proposal: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 }, select: { minHeight: 44, justifyContent: 'center' } });
