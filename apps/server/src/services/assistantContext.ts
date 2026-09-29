/**
 * How a stored message reads to the Assistant.
 *
 * Voice notes and photos are persisted with EMPTY `content`, so reading
 * `content` alone made them invisible to the Assistant: a voice note got no
 * reply at all when it was the first message in the chat. A voice note reads
 * as its transcript; an attachment with no text reads as a short placeholder
 * so the Assistant can at least say it could not read it.
 */

export interface AssistantContextRow {
  content?: string | null;
  transcript?: string | null;
  /** Attachments as stored on the Message node: a JSON string (or parsed). */
  attachments?: unknown;
}

export const VOICE_WITHOUT_TRANSCRIPT = '[Voice message — no transcript is available]';
export const ATTACHMENT_WITHOUT_TEXT = '[Sent an attachment with no text]';

function parseAttachments(attachments: unknown): { mimeType?: unknown }[] {
  let value = attachments;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as { mimeType?: unknown }[]) : [];
}

export function assistantTextForMessage(row: AssistantContextRow): string {
  const content = (row.content ?? '').trim();
  const transcript = (row.transcript ?? '').trim();
  if (transcript) {
    const voice = `[Voice message] ${transcript}`;
    return content ? `${content}\n${voice}` : voice;
  }
  if (content) return content;

  const attachments = parseAttachments(row.attachments);
  if (attachments.length === 0) return '';
  const hasAudio = attachments.some(
    (a) => typeof a?.mimeType === 'string' && a.mimeType.startsWith('audio/')
  );
  return hasAudio ? VOICE_WITHOUT_TRANSCRIPT : ATTACHMENT_WITHOUT_TEXT;
}
