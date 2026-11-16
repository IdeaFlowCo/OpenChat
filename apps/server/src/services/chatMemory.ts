/** Private, deterministic suggestions. No network fetches, LLM calls or new store. */
import { createHash } from 'node:crypto';
import { bindChatMemoryThing, tripMemoryThingId, getImportedChat, getImportedMessage, ImportedChatError, listImportedMessages, type ImportedMessageView } from './importedChats.js';
import { addNote, deleteNote, getThing, PrivateGraphError, resolvePrivateThing, type Provenance } from './privateGraph.js';

export type MemoryCategory = 'links' | 'places' | 'dates' | 'bookings' | 'files' | 'tasks' | 'decisions' | 'saved' | 'hashtags';
export interface MemoryItem { id: string; category: MemoryCategory; label: string; url: string | null; sourceMessageIds: string[] }
type Source = Pick<ImportedMessageView, 'sourceMessageId' | 'text' | 'kind' | 'mediaType'>;
const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function extractChatMemory(messages: Source[], savedIds: Set<string> = new Set()): MemoryItem[] {
  const items = new Map<string, MemoryItem>();
  const add = (category: MemoryCategory, label: string, messageId: string, url: string | null = null, identity?: string) => {
    label = label.trim().slice(0, 500);
    if (!label) return;
    const id = key(`${category}:${identity ?? url ?? label.toLowerCase().replace(/\s+/g, ' ')}`);
    const existing = items.get(id);
    if (existing) { if (!existing.sourceMessageIds.includes(messageId)) existing.sourceMessageIds.push(messageId); }
    else items.set(id, {id, category, label, url, sourceMessageIds: [messageId]});
  };
  for (const message of messages) {
    if (message.kind === 'deleted' || message.kind === 'system') continue;
    const text = message.text ?? '';
    const source = message.sourceMessageId;
    // Explicit tags only; URL fragments and words joined to '#' are not tags.
    const tagText = text.replace(/https?:\/\/[^\s<>]+/gi, ' ').normalize('NFC');
    for (const match of tagText.matchAll(/(?<![\p{L}\p{N}\p{M}_/#?=&])#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*)/gu)) {
      if (match[1]!.length <= 64) add('hashtags', `#${match[1]!.toLowerCase()}`, source);
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
      try {
        const url = new URL(match[0].replace(/[.,;!?)\]]+$/, ''));
        if (url.username || url.password) continue;
        url.hash = '';
        for (const name of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
        url.searchParams.sort();
        add('links', `${url.hostname}${url.pathname === '/' ? '' : decodeURI(url.pathname)}`, source, url.href);
        if (/(^|\.)(maps\.google\.com|maps\.apple\.com|maps\.app\.goo\.gl)$/.test(url.hostname) || /google\.[^/]+\/maps/.test(url.href)) add('places', 'Map shared in conversation', source, url.href);
      } catch { /* invalid URL stays in the source message */ }
    }
    // Candidates retain the source's words, never infer a year/timezone or confirmed status.
    for (const line of text.split(/\n/).map(value => value.trim()).filter(Boolean)) {
      if (/\b\d{1,6}\s+(?:[\w.'-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|boulevard|blvd|court|ct)\b/i.test(line)) add('places', line, source);
      if (/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(line)) add('dates', line, source);
      if (/\b(?:confirmation|reservation|booking|booked|check-in|check-out)\b/i.test(line)) add('bookings', line, source);
      if (/\b(?:todo|to-do|need to|remember to|please bring|can (?:you|someone)|i(?:'ll| will))\b/i.test(line)) add('tasks', line, source);
      if (/\b(?:decided|agreed|let's go with|we're going with|decision:)\b/i.test(line)) add('decisions', line, source);
    }
    if (message.kind === 'media') add('files', `${message.mediaType ?? 'Attachment'} · media not imported`, source, null, source);
    if (savedIds.has(source)) add('saved', text || 'Saved attachment', source);
  }
  return [...items.values()];
}
const thingName = (chatId: string) => `Chat memory · ${chatId}`;
// Retain the v1 storage marker and chat pointer for compatibility with saved references.
const marker = (chatId: string, sourceMessageId: string) => JSON.stringify({openchatTripMemory: 1, chatId, sourceMessageId});
async function memoryState(ownerId: string, chatId: string) {
  const thingId = await tripMemoryThingId(ownerId, chatId);
  const state = {saved: new Map<string, string[]>(), dismissed: new Set<string>()};
  if (thingId) {
    let detail;
    try { detail = await getThing(ownerId, thingId); }
    catch (error) { if (error instanceof PrivateGraphError && error.status === 404) return state; throw error; }
    for (const note of detail.notes) {
      try {
        const value = JSON.parse(note.text);
        if (value.chatId !== chatId) continue;
        if (value.openchatTripMemory === 1 && typeof value.sourceMessageId === 'string') state.saved.set(value.sourceMessageId, [...(state.saved.get(value.sourceMessageId) ?? []), note.id]);
        if (value.openchatChatMemoryDismiss === 1 && typeof value.itemId === 'string') state.dismissed.add(value.itemId);
      } catch { /* ordinary private note */ }
    }
  }
  return state;
}
export async function getChatMemory(ownerId: string, chatId: string) {
  const chat = await getImportedChat(ownerId, chatId); // authenticate ownership before private storage lookup
  const state = await memoryState(ownerId, chatId);
  const saved = new Set(state.saved.keys());
  let before: string | undefined;
  let nextCursor: string | null = null;
  const messages: ImportedMessageView[] = [];
  do {
    const page = await listImportedMessages(ownerId, chatId, {before, limit: 200});
    messages.push(...page.messages); nextCursor = page.nextCursor; before = nextCursor ?? undefined;
  } while (nextCursor && messages.length < 2000);
  // A saved old message remains reachable beyond the bounded automatic scan.
  for (const source of saved) if (!messages.some(message => message.sourceMessageId === source)) {
    try { messages.push(await getImportedMessage(ownerId, chatId, source)); }
    catch (error) { if (!(error instanceof ImportedChatError && error.status === 404)) throw error; }
  }
  return {items: extractChatMemory(messages, saved).filter(item => !state.dismissed.has(item.id)), scannedMessages: Math.min(messages.length, 2000), truncated: !!nextCursor, coverage: chat.coverage};
}
export async function saveChatMessage(ownerId: string, chatId: string, raw: unknown, by: Provenance) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as any).sourceMessageId !== 'string' || Object.keys(raw).some(name => name !== 'sourceMessageId')) throw new ImportedChatError(400, 'Give only a sourceMessageId');
  const sourceMessageId = (raw as {sourceMessageId: string}).sourceMessageId;
  const message = await getImportedMessage(ownerId, chatId, sourceMessageId);
  if (message.kind === 'deleted' || message.kind === 'system') throw new ImportedChatError(400, 'This message cannot be saved');
  let thingId = await tripMemoryThingId(ownerId, chatId);
  const previousId = thingId;
  if (thingId) {
    try { await getThing(ownerId, thingId); }
    catch (error) { if (error instanceof PrivateGraphError && error.status === 404) thingId = null; else throw error; }
  }
  if (!thingId) {
    const thing = await resolvePrivateThing(ownerId, {kind: 'project', name: thingName(chatId), description: 'Private saved references to an imported chat. Visible only to you.'});
    thingId = await bindChatMemoryThing(ownerId, chatId, thing.id, previousId);
  }
  await addNote(ownerId, {kind: 'thing', id: thingId}, marker(chatId, sourceMessageId), by);
  return {saved: true, thingId};
}

/** Remove only this chat/source's v1 save markers; source text and other notes stay intact. */
export async function removeChatSave(ownerId: string, chatId: string, sourceMessageId: string) {
  await getImportedChat(ownerId, chatId);
  const state = await memoryState(ownerId, chatId);
  for (const noteId of state.saved.get(sourceMessageId) ?? []) {
    try { await deleteNote(ownerId, noteId); }
    catch (error) { if (!(error instanceof PrivateGraphError && error.status === 404)) throw error; }
  }
  return {removed: true};
}
/** Dismissal is an owner-private note, never a shared task or source mutation. */
export async function dismissChatSuggestion(ownerId: string, chatId: string, raw: unknown, by: Provenance) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as any).itemId !== 'string' || Object.keys(raw).some(name => name !== 'itemId')) throw new ImportedChatError(400, 'Give only an itemId');
  const itemId = (raw as {itemId: string}).itemId;
  const memory = await getChatMemory(ownerId, chatId);
  const state = await memoryState(ownerId, chatId);
  if (state.dismissed.has(itemId)) return {dismissed: true};
  const item = memory.items.find(candidate => candidate.id === itemId);
  if (!item || item.category === 'saved' || item.category === 'hashtags') throw new ImportedChatError(404, 'Suggestion not found');
  let thingId = await tripMemoryThingId(ownerId, chatId);
  const previousId = thingId;
  if (thingId) {
    try { await getThing(ownerId, thingId); }
    catch (error) { if (error instanceof PrivateGraphError && error.status === 404) thingId = null; else throw error; }
  }
  if (!thingId) {
    const thing = await resolvePrivateThing(ownerId, {kind: 'project', name: thingName(chatId), description: 'Private memory references and choices for this chat.'});
    thingId = await bindChatMemoryThing(ownerId, chatId, thing.id, previousId);
  }
  await addNote(ownerId, {kind: 'thing', id: thingId}, JSON.stringify({openchatChatMemoryDismiss: 1, chatId, itemId}), by);
  return {dismissed: true};
}
