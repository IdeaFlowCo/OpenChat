import { authenticatedFetch, getToken, OPENCHAT_URL } from '../api/client';

export const TRANSLATION_LANGUAGES = ['English', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Spanish', 'French', 'German', 'Japanese', 'Korean', 'Hindi', 'Arabic', 'Portuguese'] as const;
export type TranslationLanguage = typeof TRANSLATION_LANGUAGES[number];
export type TranslationMode = 'ask' | 'auto' | 'off';
export interface TranslationPreference { mode: TranslationMode; language: TranslationLanguage }
export interface TranslationPreferences extends TranslationPreference { chats: Record<string, Partial<TranslationPreference>> }
export const DEFAULT_TRANSLATION: TranslationPreferences = { mode: 'ask', language: 'English', chats: {} };
export const MAX_TRANSLATION_LENGTH = 12000;
export interface TranslationResult { text: string; sourceLanguage: string; translated: boolean }

export function readTranslationPreferences(raw: string | null): TranslationPreferences {
  try {
    const input = JSON.parse(raw || '{}');
    const valid = (value: unknown): Partial<TranslationPreference> => {
      if (!value || typeof value !== 'object') return {};
      const p = value as TranslationPreference;
      return {
        ...(['ask', 'auto', 'off'].includes(p.mode) ? { mode: p.mode } : {}),
        ...(TRANSLATION_LANGUAGES.includes(p.language) ? { language: p.language } : {}),
      };
    };
    return { ...DEFAULT_TRANSLATION, ...valid(input), chats: Object.fromEntries(
      Object.entries(input.chats || {}).map(([id, p]) => [id, valid(p)]),
    ) };
  } catch { return { ...DEFAULT_TRANSLATION, chats: {} }; }
}

// Conservative on-device suggestion. No message is sent to AI until enabled
// or explicitly translated. Latin-script ambiguity is left to manual controls.
export function likelyNeedsTranslation(text: string, language: TranslationLanguage): boolean {
  const prose = text.replace(/https?:\/\/\S+|www\.\S+/g, '');
  if (!/\p{L}/u.test(prose)) return false;
  if (language.startsWith('Chinese')) return /[A-Za-z]{3,}|[\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff\u0400-\u04ff]/u.test(prose);
  if (language === 'Japanese') return /[A-Za-z]{3,}|[\uac00-\ud7af\u0600-\u06ff]/u.test(prose);
  if (language === 'Korean') return /[A-Za-z]{3,}|[\u3400-\u9fff\u3040-\u30ff\u0600-\u06ff]/u.test(prose);
  if (language === 'Arabic') return /[A-Za-z]{3,}|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(prose);
  if (language === 'Hindi') return /[A-Za-z]{3,}|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff]/u.test(prose);
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff\u0400-\u04ff\u0900-\u097f]/u.test(prose);
}

export function translationKey(text: string, language: TranslationLanguage): string {
  return JSON.stringify([language, text]);
}

// One queue/cache per signed-in account. Originals and translations are never
// written to storage. Pace visible messages below the shared 60/min AI limit.
export class TranslationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, TranslationResult>();
  private nextStart = 0;
  constructor(private readonly send = fetchTranslation, private readonly interval = 1200) {}
  request(text: string, language: TranslationLanguage, signal: AbortSignal): Promise<TranslationResult> {
    const key = translationKey(text, language);
    const run = async () => {
      if (signal.aborted) throw new Error('Translation cancelled');
      const cached = this.cache.get(key);
      if (cached) return cached;
      const wait = Math.max(0, this.nextStart - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (signal.aborted) throw new Error('Translation cancelled');
      this.nextStart = Date.now() + this.interval;
      const result = await this.send(text, language, signal);
      if (signal.aborted) throw new Error('Translation cancelled');
      this.cache.set(key, result);
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      return result;
    };
    const pending = this.tail.then(run, run);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

async function fetchTranslation(text: string, language: TranslationLanguage, signal: AbortSignal): Promise<TranslationResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel);
  const timeout = setTimeout(cancel, 45000);
  try {
    const token = await getToken();
    if (signal.aborted) throw new Error('Translation cancelled');
    const response = await authenticatedFetch(`${OPENCHAT_URL}/api/ai/translate`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, targetLanguage: language }),
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error('Translation limit reached. Try again in a minute.');
      if (response.status === 503) throw new Error('Translation is temporarily unavailable.');
      throw new Error('Could not translate. Please try again.');
    }
    const data = await response.json() as TranslationResult;
    if (typeof data.text !== 'string' || !data.text.trim() || typeof data.sourceLanguage !== 'string' || typeof data.translated !== 'boolean') throw new Error('Translation was incomplete. Please try again.');
    return data;
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('Translation timed out. Please try again.');
    throw error;
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}
