import { useEffect, useState, type ReactNode } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useChatTranslation } from '../contexts/TranslationContext';
import { MAX_TRANSLATION_LENGTH, translationKey, type TranslationResult } from '../services/translation';
import { space, type } from '../theme/tokens';
import { MessageText } from './MessageText';

export function TranslatedMessage({ conversationId, content, incoming, requested, active, color, onLongPress, children }: {
  conversationId: string; content: string; incoming: boolean; requested: number; active: boolean;
  color: string; onLongPress: () => void; children: ReactNode;
}) {
  const { context, preference } = useChatTranslation(conversationId);
  const queue = context?.queue;
  const enabled = !!context?.ready && active && (requested || (incoming && preference.mode === 'auto')) && /\p{L}/u.test(content);
  const key = translationKey(content, preference.language);
  const [state, setState] = useState<{ key: string; result?: TranslationResult; error?: string } | null>(null);
  const [originalKey, setOriginalKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !queue) return;
    setOriginalKey(null);
    if (content.length > MAX_TRANSLATION_LENGTH) {
      setState({ key, error: `This message is too long to translate (limit ${MAX_TRANSLATION_LENGTH.toLocaleString()} characters).` });
      return;
    }
    const controller = new AbortController();
    setState({ key });
    queue.request(content, preference.language, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ key, result });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : 'Could not translate.' });
    });
    return () => controller.abort();
  }, [enabled, queue, content, preference.language, key, retry, requested]);
  const result = enabled && state?.key === key ? state.result : undefined;
  const error = enabled && state?.key === key ? state.error : undefined;
  const showTranslation = result?.translated && originalKey !== key;
  return <View>
    {showTranslation ? <MessageText content={result.text} color={color} onLongPress={onLongPress} /> : children}
    {enabled && <View style={{ marginTop: space[1] }}>
      {result?.translated ? <>
        <Text style={[type.meta, { color }]}>{requested ? 'Translated' : 'Auto-translated'} · {result.sourceLanguage} → {preference.language}</Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => setOriginalKey(showTranslation ? key : null)} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={[type.label, { color, textDecorationLine: 'underline' }]}>{showTranslation ? 'Show original' : 'Show translation'}</Text>
        </TouchableOpacity>
      </> : error ? <>
        <Text accessibilityRole="alert" style={[type.meta, { color }]}>{error}</Text>
        {content.length <= MAX_TRANSLATION_LENGTH && <TouchableOpacity accessibilityRole="button" onPress={() => setRetry(n => n + 1)} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={[type.label, { color, textDecorationLine: 'underline' }]}>Retry translation</Text>
        </TouchableOpacity>}
      </> : !result ? <Text accessibilityLiveRegion="polite" style={[type.meta, { color }]}>Translating…</Text>
        : requested ? <Text style={[type.meta, { color }]}>Already in {preference.language}</Text> : null}
    </View>}
  </View>;
}
