/**
 * Voice-message transcription (openchat-4jn).
 *
 * On a message with an audio attachment, fetch the audio from its (public GCS)
 * URL and transcribe it with OpenAI Whisper, then persist `transcript` on the
 * Message node and emit `message:transcript` so clients render it under the
 * voice bubble. Best-effort + async — never blocks the send; no-ops gracefully
 * if OPENAI_API_KEY is unset (same key used by the Assistant + embeddings).
 *
 * Why Whisper: no AssemblyAI/Deepgram key is provisioned here, but
 * OPENAI_API_KEY is present + forwarded. Swap the provider here if a dedicated
 * speech key is added later.
 */
import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';

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

/** Transcribe an audio URL with Whisper. Returns trimmed text or null. */
export async function transcribeAudio(url: string, mimeType: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[transcribe] OPENAI_API_KEY not set — skipping transcription');
    return null;
  }
  try {
    const audioRes = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!audioRes.ok) {
      console.warn('[transcribe] fetch audio failed', audioRes.status, url);
      return null;
    }
    const buf = await audioRes.arrayBuffer();
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
  attachments: unknown
): Promise<void> {
  if (!Array.isArray(attachments)) return;
  const audio = (attachments as Attachmentish[]).find(
    (a) =>
      a && typeof a.mimeType === 'string' && a.mimeType.startsWith('audio/') && typeof a.url === 'string'
  );
  if (!audio) return;

  const text = await transcribeAudio(audio.url as string, audio.mimeType as string);
  if (!text) return;

  const s = getDriver().session();
  try {
    await s.run('MATCH (m:Message {id: $id}) SET m.transcript = $t', { id: messageId, t: text });
  } catch (e) {
    console.warn('[transcribe] persist failed:', e);
    return;
  } finally {
    await s.close();
  }

  if (io) {
    io.to(`conversation:${conversationId}`).emit('message:transcript', {
      messageId,
      conversationId,
      transcript: text,
    });
  }
}
