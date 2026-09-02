/**
 * Voice-message transcription (openchat-4jn; upgraded 2026-09-02 for
 * first-class voice notes).
 *
 * On a message with an audio attachment, fetch the audio from its (public GCS)
 * URL and transcribe it — Deepgram (nova-2) first when DEEPGRAM_API_KEY is
 * set (typically 1-2s for a short note), OpenAI Whisper as fallback — then
 * persist `transcript` on the Message node and emit `message:transcript` so
 * clients render it as the message's first-class text.
 *
 * Post-processing: spoken hashtags ("hashtag community house") are normalized
 * to typed ones (#CommunityHouse) and the transcript runs through the same
 * tag → Thought extraction as typed messages, so voice notes are first-class
 * for capture too.
 *
 * Best-effort + async — never blocks the send; no-ops gracefully with no keys.
 */
import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { normalizeSpokenHashtags } from './normalizeSpokenHashtags.js';
import { createThoughtsFromMessageTags } from './extractThoughtsFromMessage.js';

interface Attachmentish {
  url?: unknown;
  mimeType?: unknown;
}

function extFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'audio';
}

/** Deepgram nova-2 prerecorded — fast path (~1-2s for short notes). */
async function transcribeWithDeepgram(buf: ArrayBuffer, mimeType: string): Promise<string | null> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': mimeType },
        body: buf,
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!r.ok) {
      console.warn('[transcribe] deepgram error', r.status, await r.text().catch(() => ''));
      return null;
    }
    const data = (await r.json().catch(() => null)) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
    } | null;
    const text = (data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
    return text || null;
  } catch (e) {
    console.warn('[transcribe] deepgram failed:', e);
    return null;
  }
}

/** OpenAI Whisper — fallback path. */
async function transcribeWithWhisper(buf: ArrayBuffer, mimeType: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[transcribe] OPENAI_API_KEY not set — skipping transcription');
    return null;
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mimeType }), `voice.${extFor(mimeType)}`);
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      console.warn('[transcribe] whisper error', r.status, await r.text().catch(() => ''));
      return null;
    }
    const data = (await r.json().catch(() => null)) as { text?: string } | null;
    const text = (data?.text || '').trim();
    return text || null;
  } catch (e) {
    console.warn('[transcribe] whisper failed:', e);
    return null;
  }
}

/** Transcribe an audio URL — Deepgram first, Whisper fallback. */
export async function transcribeAudio(url: string, mimeType: string): Promise<string | null> {
  try {
    const audioRes = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!audioRes.ok) {
      console.warn('[transcribe] fetch audio failed', audioRes.status, url);
      return null;
    }
    const buf = await audioRes.arrayBuffer();
    const started = Date.now();
    let text = await transcribeWithDeepgram(buf, mimeType);
    let provider = 'deepgram';
    if (!text) {
      text = await transcribeWithWhisper(buf, mimeType);
      provider = 'whisper';
    }
    if (text) console.log(`[transcribe] ${provider} ok in ${Date.now() - started}ms (${text.length} chars)`);
    return text;
  } catch (e) {
    console.warn('[transcribe] failed:', e);
    return null;
  }
}

/**
 * If the message has an audio attachment, transcribe it (async, best-effort),
 * persist `transcript`, and emit `message:transcript` to the conversation room.
 */
export async function maybeTranscribeMessage(
  io: IOServer | undefined,
  messageId: string,
  conversationId: string,
  attachments: unknown,
  senderId?: string
): Promise<void> {
  if (!Array.isArray(attachments)) return;
  const audio = (attachments as Attachmentish[]).find(
    (a) =>
      a && typeof a.mimeType === 'string' && a.mimeType.startsWith('audio/') && typeof a.url === 'string'
  );
  if (!audio) return;

  const raw = await transcribeAudio(audio.url as string, audio.mimeType as string);
  if (!raw) return;

  // Spoken "hashtag community house" → "#CommunityHouse" so voice notes are
  // first-class for tag capture; the normalized text is what we display too.
  const text = normalizeSpokenHashtags(raw);

  const s = getDriver().session();
  try {
    await s.run('MATCH (m:Message {id: $id}) SET m.transcript = $t', { id: messageId, t: text });

    // Upgrade the chat-list preview from the "Voice note" placeholder to the
    // actual transcript (first-class voice notes). Guarded so a newer message
    // that already replaced the preview is left alone.
    await s.run(
      `MATCH (c:Conversation {id: $convId})
       WHERE c.lastMessagePreview IN ['Voice note', '📷 Photo', '🎤 Voice message']
       SET c.lastMessagePreview = left($t, 100)`,
      { convId: conversationId, t: text }
    ).catch(() => { /* best-effort */ });

    if (io) {
      io.to(`conversation:${conversationId}`).emit('message:transcript', {
        messageId,
        conversationId,
        transcript: text,
      });
    }

    // Same tag → Thought pipeline as typed messages (best-effort).
    if (senderId) {
      await createThoughtsFromMessageTags(s, {
        senderId,
        messageId,
        conversationId,
        content: text,
        io,
      });
    }
  } catch (e) {
    console.warn('[transcribe] persist failed:', e);
  } finally {
    await s.close();
  }
}
