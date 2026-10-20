import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Conversation, Message } from '../api/client';
import type { QueuedPhoto } from './photoOutbox';

export type PendingMessage = {
  clientId: string;
  message: Message;
  state: 'queued' | 'failed';
  /** Photos for this message, uploaded by the outbox before sending. */
  photos?: QueuedPhoto[];
  /** Why the entry is waiting or failed, shown under the bubble. */
  detail?: string;
};
type Cache = { conversations: Conversation[]; threads: Record<string, Message[]> };
export type ChatStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem' | 'getAllKeys'>;

const queues = new WeakMap<ChatStorage, Map<string, Promise<void>>>();

/** Account-scoped, bounded history; outbox entries have independent keys so
 * two web tabs cannot overwrite each other's newly composed messages. */
export class OfflineChat {
  readonly pending = new Map<string, PendingMessage>();
  cache: Cache = { conversations: [], threads: {} };
  private writes = Promise.resolve();
  private closed = false;
  private readonly prefix: string;
  private readonly generationKey: string;
  private readonly generation: Promise<string | null>;

  async isActive(): Promise<boolean> {
    const generation = await this.generation;
    return generation === await this.storage.getItem(this.generationKey) && !this.closed;
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(this.generationKey, action);
      return;
    }
    let queue = queues.get(this.storage);
    if (!queue) { queue = new Map(); queues.set(this.storage, queue); }
    const next = (queue.get(this.prefix) ?? Promise.resolve()).then(action);
    queue.set(this.prefix, next.catch(() => {}));
    await next;
  }

  constructor(readonly accountId: string, private storage: ChatStorage = AsyncStorage) {
    this.prefix = `openchat:offline:v1:${encodeURIComponent(accountId)}:`;
    this.generationKey = `openchat:account-generation:${encodeURIComponent(accountId)}`;
    this.generation = this.storage.getItem(this.generationKey);
  }

  private write(action: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Chat session ended'));
    const next = this.writes.then(() => this.exclusive(async () => {
      if (!await this.isActive()) throw new Error('Chat session ended');
      await action();
    }));
    this.writes = next.catch(() => {});
    return next;
  }

  async load(): Promise<void> {
    if (!await this.isActive()) return;
    const raw = await this.storage.getItem(`${this.prefix}cache`);
    if (raw) {
      try {
        const cache = JSON.parse(raw) as Cache;
        if (Array.isArray(cache.conversations) && cache.threads && typeof cache.threads === 'object') {
          this.cache = cache;
        }
      } catch { /* A corrupt history cache must not prevent loading the outbox. */ }
    }
    const keys = (await this.storage.getAllKeys()).filter(key => key.startsWith(`${this.prefix}outbox:`));
    for (const key of keys) {
      const raw = await this.storage.getItem(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as PendingMessage;
        if (entry.clientId && entry.message?.senderId === this.accountId
          && entry.message.id === `local-${entry.clientId}`
          && (entry.state === 'queued' || entry.state === 'failed')) {
          this.pending.set(entry.clientId, entry);
        }
      } catch { /* Ignore malformed entries without deleting recoverable data. */ }
    }
  }

  private saveCache(): Promise<void> {
    this.cache.conversations = this.cache.conversations.slice(0, 200);
    // Stay below native AsyncStorage's per-row limits. Eviction never touches
    // the independently stored outbox.
    let json = JSON.stringify(this.cache);
    while (json.length > 400000 && Object.keys(this.cache.threads).length) {
      delete this.cache.threads[Object.keys(this.cache.threads)[0]];
      json = JSON.stringify(this.cache);
    }
    return this.write(() => this.storage.setItem(`${this.prefix}cache`, json));
  }

  saveConversations(conversations: Conversation[]): Promise<void> {
    this.cache.conversations = conversations;
    const allowed = new Set(conversations.map(conversation => conversation.id));
    this.cache.threads = Object.fromEntries(Object.entries(this.cache.threads).filter(([id]) => allowed.has(id)));
    return this.saveCache();
  }

  saveMessages(id: string, messages: Message[]): Promise<void> {
    // Local messages belong in the durable outbox, never in the evictable cache.
    const threads = { ...this.cache.threads };
    delete threads[id];
    threads[id] = messages.filter(message => !message.id.startsWith('local-')).slice(-100);
    this.cache.threads = Object.fromEntries(Object.entries(threads).slice(-30));
    return this.saveCache();
  }

  forgetConversation(id: string): Promise<void> {
    delete this.cache.threads[id];
    this.cache.conversations = this.cache.conversations.filter(conversation => conversation.id !== id);
    return this.saveCache();
  }

  async put(entry: PendingMessage): Promise<void> {
    // Do not report success or clear the composer before durable storage succeeds.
    const json = JSON.stringify(entry);
    await this.write(() => this.storage.setItem(`${this.prefix}outbox:${entry.clientId}`, json));
    if (await this.isActive()) this.pending.set(entry.clientId, entry);
  }

  async remove(clientId: string): Promise<void> {
    await this.write(() => this.storage.removeItem(`${this.prefix}outbox:${clientId}`));
    this.pending.delete(clientId);
  }

  /** Stop this session immediately. Explicit sign-out erases local history and
   * pending sends after older writes finish; expiry preserves them for re-login. */
  async close(erase = false): Promise<void> {
    this.closed = true;
    if (erase) {
      await this.storage.setItem(this.generationKey, `${Date.now()}-${Math.random()}`);
      await this.exclusive(async () => {
        const keys = (await this.storage.getAllKeys()).filter(key => key.startsWith(this.prefix));
        await Promise.all(keys.map(key => this.storage.removeItem(key)));
      });
      this.pending.clear();
      this.cache = { conversations: [], threads: {} };
    }
    await this.writes;
  }
}

export function retryableSendError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return !status || status === 408 || status === 429 || status >= 500;
}
