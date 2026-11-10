/**
 * One timeline from a conversation's own messages and the chats shared into
 * it (OpenChat-c8to.4). Pure, so the ordering rules are testable.
 *
 * Mirrored messages are read-only history from another network. They sit in
 * time order between OpenChat messages in the unified view, and never count as
 * OpenChat messages: nothing here changes what is sent, read or notified.
 */
import type { ConversationSource, Message, SourceMessage } from '../api/client';

export type SourceMode = 'unified' | 'openchat' | 'mirror';
export const SOURCE_MODES: readonly SourceMode[] = ['unified', 'openchat', 'mirror'];

export interface MirroredEntry {
  /** Unique across sources. */
  key: string;
  sourceId: string;
  network: string;
  message: SourceMessage;
  /** The viewer wrote it: they shared the source and this is their side of it. */
  isOwn: boolean;
  senderLabel: string;
  /** Stable per person within a source, for run grouping and colour. */
  senderKey: string;
}

export type TimelineEntry =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'mirror'; at: string; mirror: MirroredEntry };

/** A source's messages as timeline entries, for a given viewer. */
export function mirroredEntries(source: ConversationSource, messages: SourceMessage[], viewerUserId: string | undefined): MirroredEntry[] {
  return messages.map(message => {
    const sender = message.sender;
    const fromSharer = !!sender?.isSharer;
    return {
      key: `mirror:${source.id}:${message.id}`,
      sourceId: source.id,
      network: source.network,
      message,
      isOwn: fromSharer && !!viewerUserId && source.sharedBy.userId === viewerUserId,
      senderLabel: fromSharer ? (source.sharedBy.name || sender!.label) : sender?.label ?? 'Unknown sender',
      senderKey: `${source.id}:${sender?.participantId ?? 'unknown'}`,
    };
  });
}

const time = (iso: string) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? ms : 0; };

/**
 * Oldest first. In the unified view a mirrored message is held back while
 * older OpenChat pages are still unloaded and it predates the oldest loaded
 * OpenChat message; otherwise it would appear above history that is not on
 * screen yet and jump when that history loads.
 */
export function mergeTimeline(messages: Message[], mirrored: MirroredEntry[], mode: SourceMode, hasMoreMessages: boolean): TimelineEntry[] {
  const own: TimelineEntry[] = mode === 'mirror' ? [] : messages.map(message => ({ kind: 'message', at: message.createdAt, message }));
  if (mode === 'openchat' || !mirrored.length) return own;
  const floor = mode === 'unified' && hasMoreMessages && messages.length ? time(messages[0]!.createdAt) : null;
  const mirror: TimelineEntry[] = [...mirrored]
    .filter(entry => floor === null || time(entry.message.sentAt) >= floor)
    .sort((a, b) => time(a.message.sentAt) - time(b.message.sentAt) || a.key.localeCompare(b.key))
    .map(entry => ({ kind: 'mirror', at: entry.message.sentAt, mirror: entry }));
  if (mode === 'mirror') return mirror;
  // Stable merge of two sorted lists; at the same instant the mirrored message comes first.
  const out: TimelineEntry[] = [];
  let i = 0, j = 0;
  while (i < own.length || j < mirror.length) {
    if (j >= mirror.length || (i < own.length && time(own[i]!.at) < time(mirror[j]!.at))) out.push(own[i++]!);
    else out.push(mirror[j++]!);
  }
  return out;
}

const NETWORKS: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', signal: 'Signal', imessage: 'iMessage', instagram: 'Instagram', messenger: 'Messenger', linkedin: 'LinkedIn', openchat: 'OpenChat' };
export const sourceNetworkName = (network: string) => NETWORKS[network] ?? network.charAt(0).toUpperCase() + network.slice(1);

/** The word on the third switch position: the network when there is one, else "Mirrored". */
export function mirrorModeLabel(sources: Pick<ConversationSource, 'network'>[]): string {
  const networks = [...new Set(sources.map(source => source.network))];
  return networks.length === 1 ? sourceNetworkName(networks[0]!) : 'Mirrored';
}
