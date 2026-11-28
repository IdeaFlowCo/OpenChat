import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, type WebsiteAnswer, type WebsiteReview } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, type } from '../theme/tokens';
import { Button, Card } from './ui';

export function WebsiteRecipientDraft({ domain, url, onSent }: { domain: string; url: string | null; onSent: (conversationId: string) => void }) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const [question, setQuestion] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [answer, setAnswer] = useState<WebsiteAnswer>();
  const [review, setReview] = useState<WebsiteReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const inputStyle = [styles.input, { color: r.text, backgroundColor: r.input, borderColor: r.line }];

  const act = async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Try again.'); }
    finally {
      running.current = false;
      setBusy(false);
    }
  };
  const ask = (selectedText?: string) => act(async () => {
    setReview(undefined);
    setAnswer(!url && !selectedText ? { status: 'unreadable' } : await api.askAboutWebsite({ url, question, excerpt: selectedText }));
  });
  const reviewMessage = () => act(async () => {
    if (!url) return;
    setAnswer(undefined);
    setReview(await api.reviewWebsiteMessage({ url, question }));
  });
  const send = (token: string) => act(async () => {
    const message = await api.sendWebsiteMessage(token);
    onSent(message.conversationId);
  });
  const ready = !!question.trim() && !busy;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text style={[type.title, { color: r.text }]} accessibilityRole="header">{domain}</Text>
      <TextInput
        accessibilityLabel="Question about this website"
        style={inputStyle}
        placeholder="What would you like to ask?"
        placeholderTextColor={r.decoration}
        multiline
        maxLength={4000}
        editable={!busy}
        value={question}
        onChangeText={value => { setQuestion(value); setReview(undefined); setAnswer(undefined); setError(''); }}
      />
      <Button variant="primary" label="Ask my agent" disabled={!ready} onPress={() => void ask()} />
      {url && <Button label="Find official representative" disabled={!ready} onPress={() => void reviewMessage()} />}
      {!!error && <Text accessibilityRole="alert" style={[type.body, { color: r.danger }]}>{error}</Text>}
      {answer && (
        <Card>
          {answer.status === 'answered' ? (
            <View style={styles.content}>
              <Text style={[type.label, { color: r.textMeta }]}>OpenChat Agent · Private answer</Text>
              <Text selectable style={[type.body, { color: r.text }]}>{answer.answer}</Text>
              <Text selectable style={[type.meta, { color: r.textMeta }]}>{answer.url ?? 'Text you shared'}</Text>
              <Text selectable style={[type.body, { color: r.textSecondary }]}>“{answer.quote}”</Text>
            </View>
          ) : (
            <View style={styles.content}>
              <Text accessibilityRole="alert" style={[type.body, { color: r.text }]}>
                {answer.status === 'unreadable' ? 'Your agent couldn’t read this page.' : 'The source didn’t support an answer.'}
              </Text>
              <TextInput
                accessibilityLabel="Page text to share privately"
                style={inputStyle}
                placeholder="Paste text you want your agent to use"
                placeholderTextColor={r.decoration}
                multiline
                maxLength={16000}
                editable={!busy}
                value={excerpt}
                onChangeText={setExcerpt}
              />
              <Button label="Ask with this text" disabled={!ready || !excerpt.trim()} onPress={() => void ask(excerpt)} />
            </View>
          )}
        </Card>
      )}
      {review?.status === 'unverified' && (
        <Text accessibilityRole="alert" style={[type.body, { color: r.textSecondary }]}>No verified OpenChat representative is available for this website.</Text>
      )}
      {review?.status === 'verified' && (
        <Card>
          <View style={styles.content}>
            <Text style={[type.label, { color: r.text }]}>To {review.name} · {review.domain}</Text>
            {review.host !== review.domain && <Text style={[type.meta, { color: r.textMeta }]}>Hosted by {review.host}</Text>}
            <Text selectable style={[type.body, { color: r.text }]}>{review.content}</Text>
            <Button variant="primary" label={`Send to ${review.domain}`} disabled={busy} onPress={() => void send(review.token)} />
            <Button label="Cancel review" variant="ghost" disabled={busy} onPress={() => setReview(undefined)} />
          </View>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: space[3], paddingVertical: space[3] },
  input: {
    ...type.body, padding: space[3], borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md, minHeight: space[8] * 2, textAlignVertical: 'top',
  },
});
