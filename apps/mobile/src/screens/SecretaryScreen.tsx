import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, type SecretaryAnswer, type SecretaryConfig } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

export function SecretaryScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [config, setConfig] = useState<SecretaryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');

  const load = useCallback(async () => {
    try {
      setConfig(await api.getSecretary());
    } catch (error) {
      Alert.alert('Could not load Secretary', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    if (!config) return;
    const previous = config.enabled;
    setConfig({ ...config, enabled });
    try {
      await api.setSecretaryEnabled(enabled);
    } catch (error) {
      setConfig((current) => current ? { ...current, enabled: previous } : current);
      Alert.alert('Could not update Secretary', error instanceof Error ? error.message : 'Please try again.');
    }
  }, [config]);

  const beginEdit = useCallback((entry: SecretaryAnswer) => {
    setEditingId(entry.id);
    setQuestion(entry.question);
    setAnswer(entry.answer);
  }, []);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setQuestion('');
    setAnswer('');
  }, []);

  const saveAnswer = useCallback(async () => {
    if (!question.trim() || !answer.trim() || saving) return;
    setSaving(true);
    try {
      const saved = editingId
        ? await api.updateSecretaryAnswer(editingId, { question: question.trim(), answer: answer.trim() })
        : await api.createSecretaryAnswer({ question: question.trim(), answer: answer.trim() });
      setConfig((current) => current ? {
        ...current,
        answers: editingId
          ? current.answers.map((item) => item.id === editingId ? saved : item)
          : [...current.answers, saved],
      } : current);
      resetForm();
    } catch (error) {
      Alert.alert('Could not save quick answer', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSaving(false);
    }
  }, [answer, editingId, question, resetForm, saving]);

  const removeAnswer = useCallback((entry: SecretaryAnswer) => {
    Alert.alert('Delete quick answer?', `Secretary will stop answering “${entry.question}”`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteSecretaryAnswer(entry.id);
            setConfig((current) => current ? {
              ...current,
              answers: current.answers.filter((item) => item.id !== entry.id),
            } : current);
            if (editingId === entry.id) resetForm();
          } catch (error) {
            Alert.alert('Could not delete quick answer', error instanceof Error ? error.message : 'Please try again.');
          }
        },
      },
    ]);
  }, [editingId, resetForm]);

  if (loading) {
    return <View style={[styles.center, { backgroundColor: c.background }]}><ActivityIndicator color={c.primary} /></View>;
  }

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.heroCopy}>
          <Text style={[styles.title, { color: c.textPrimary }]}>Routine questions, handled</Text>
          <Text style={[styles.body, { color: c.textSecondary }]}>Your Secretary replies in direct chats using only the exact answers you approve here.</Text>
        </View>
        <Switch
          value={config?.enabled ?? false}
          onValueChange={(value) => void toggleEnabled(value)}
          trackColor={{ false: c.border, true: c.primary }}
          accessibilityLabel="Enable Secretary auto-replies"
        />
      </View>

      <View style={[styles.notice, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
        <Text style={[styles.noticeText, { color: c.textSecondary }]}>Replies are visibly labeled “Secretary auto-reply.” Unmatched questions wait for you; group chats are never answered.</Text>
      </View>

      <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>APPROVED QUICK ANSWERS</Text>
      {config?.answers.map((entry) => (
        <TouchableOpacity
          key={entry.id}
          onPress={() => beginEdit(entry)}
          onLongPress={() => removeAnswer(entry)}
          activeOpacity={0.75}
          style={[styles.card, { backgroundColor: c.surface, borderColor: editingId === entry.id ? c.primary : c.border }]}
        >
          <Text style={[styles.question, { color: c.textPrimary }]}>{entry.question}</Text>
          <Text style={[styles.answer, { color: c.textSecondary }]}>{entry.answer}</Text>
          <Text style={[styles.cardHint, { color: c.textMuted }]}>Tap to edit · hold to delete</Text>
        </TouchableOpacity>
      ))}
      {config?.answers.length === 0 && (
        <Text style={[styles.empty, { color: c.textMuted }]}>Add one repetitive question to try the mode.</Text>
      )}

      <View style={[styles.form, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.formTitle, { color: c.textPrimary }]}>{editingId ? 'Edit quick answer' : 'Add a quick answer'}</Text>
        <Text style={[styles.inputLabel, { color: c.textSecondary }]}>When someone asks…</Text>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          placeholder="What is your address?"
          placeholderTextColor={c.textMuted}
          maxLength={200}
          style={[styles.input, { backgroundColor: c.background, borderColor: c.border, color: c.textPrimary }]}
        />
        <Text style={[styles.inputLabel, { color: c.textSecondary }]}>Reply with…</Text>
        <TextInput
          value={answer}
          onChangeText={setAnswer}
          placeholder="The exact answer people should receive"
          placeholderTextColor={c.textMuted}
          maxLength={2000}
          multiline
          style={[styles.input, styles.answerInput, { backgroundColor: c.background, borderColor: c.border, color: c.textPrimary }]}
        />
        <View style={styles.actions}>
          {editingId && (
            <TouchableOpacity onPress={resetForm} style={[styles.secondaryButton, { borderColor: c.border }]}>
              <Text style={{ color: c.textPrimary, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => void saveAnswer()}
            disabled={!question.trim() || !answer.trim() || saving}
            style={[styles.primaryButton, { backgroundColor: c.primary, opacity: !question.trim() || !answer.trim() || saving ? 0.5 : 1 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{editingId ? 'Save' : 'Add answer'}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  hero: { borderWidth: 1, borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16 },
  heroCopy: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 5 },
  body: { fontSize: 14, lineHeight: 20 },
  notice: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  noticeText: { fontSize: 13, lineHeight: 18 },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.7, marginTop: 8 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14 },
  question: { fontSize: 15, fontWeight: '600' },
  answer: { fontSize: 14, lineHeight: 20, marginTop: 5 },
  cardHint: { fontSize: 11, marginTop: 9 },
  empty: { fontSize: 14, paddingVertical: 10, textAlign: 'center' },
  form: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 8, marginTop: 4 },
  formTitle: { fontSize: 17, fontWeight: '700', marginBottom: 3 },
  inputLabel: { fontSize: 12, fontWeight: '600', marginTop: 3 },
  input: { borderWidth: 1, borderRadius: 10, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  answerInput: { minHeight: 88, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  secondaryButton: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 18 },
  primaryButton: { minHeight: 44, minWidth: 110, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 18 },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
});
