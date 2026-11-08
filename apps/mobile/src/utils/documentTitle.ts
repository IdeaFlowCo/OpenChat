/**
 * Browser tab titles for the /app web client (OpenChat-mrl2).
 *
 * The tab names what is open, then the app: `Alice — OpenChat`,
 * `Chats (3) — OpenChat`, `Settings — OpenChat`. Native ignores this.
 *
 * Conversation screens render their name as a header component, so their
 * navigation `title` option is empty. They publish the plain-text name here
 * instead; each mount gets its own token so stacked or embedded screens for
 * the same conversation do not clear each other.
 */

export const APP_NAME = 'OpenChat';

/** Screens without a `title` option that still deserve a specific tab name. */
const ROUTE_NAME_TITLES: Record<string, string> = {
  Login: 'Sign in',
  Onboarding: 'Welcome',
};

/** Routes whose tab names the open conversation when one is published. */
export const CONVERSATION_ROUTES = new Set(['Chat', 'Conversations']);

export function screenTitleFor(optionTitle: unknown, routeName: string | undefined): string | undefined {
  if (typeof optionTitle === 'string' && optionTitle.trim()) return optionTitle.trim();
  return routeName ? ROUTE_NAME_TITLES[routeName] : undefined;
}

export function formatDocumentTitle({ conversationTitle, screenTitle, unreadTotal = 0 }: {
  conversationTitle?: string;
  screenTitle?: string;
  unreadTotal?: number;
}): string {
  const conversation = conversationTitle?.trim();
  const thing = conversation || screenTitle?.trim();
  if (!thing || thing === APP_NAME) return APP_NAME;
  const count = !conversation && thing === 'Chats' && unreadTotal > 0 ? ` (${unreadTotal})` : '';
  return `${thing}${count} — ${APP_NAME}`;
}

type Entry = { token: number; conversationId: string; title: string; embedded: boolean };

let entries: Entry[] = [];
let nextToken = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Publish a mounted conversation screen's name. Returns the unregister function. */
export function publishConversationTitle(conversationId: string, title: string, embedded: boolean): () => void {
  const token = nextToken++;
  entries = [...entries, { token, conversationId, title, embedded }];
  emit();
  return () => {
    entries = entries.filter(entry => entry.token !== token);
    emit();
  };
}

/** Newest published name for a conversation, optionally only the embedded (desktop pane) one. */
export function conversationTitleFor(conversationId: string | null | undefined, embeddedOnly = false): string | undefined {
  if (!conversationId) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.conversationId === conversationId && (!embeddedOnly || entry.embedded) && entry.title.trim()) {
      return entry.title;
    }
  }
  return undefined;
}

export function subscribeConversationTitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Snapshot identity for useSyncExternalStore; changes on every publish/unpublish. */
export function getConversationTitlesSnapshot(): readonly Entry[] {
  return entries;
}

export function resolveDocumentTitle({ routeName, optionTitle, routeConversationId, activeConversationId, unreadTotal }: {
  routeName?: string;
  optionTitle?: unknown;
  routeConversationId?: string;
  activeConversationId?: string | null;
  unreadTotal?: number;
}): string {
  // The desktop list route shows the selected chat in its embedded pane; a
  // pushed Chat route names its own conversation.
  const conversationTitle = routeName === 'Chat'
    ? conversationTitleFor(routeConversationId)
    : routeName && CONVERSATION_ROUTES.has(routeName)
      ? conversationTitleFor(activeConversationId, true)
      : undefined;
  return formatDocumentTitle({ conversationTitle, screenTitle: screenTitleFor(optionTitle, routeName), unreadTotal });
}
