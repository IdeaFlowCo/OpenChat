/**
 * ChatScreenRouter — NATIVE / narrow-web shim (OpenChat-601).
 *
 * Registered at the "Chat" route key in the ChatsNavigator stack. On
 * native and narrow web this just re-exports the existing ChatScreen with
 * its full feature set (voice messages, link previews, transforms,
 * reactions, edit/delete, mentions, image attachments, forwarding, etc.).
 *
 * The .web.tsx sibling adds desktop-mode behavior: instead of pushing a
 * Chat screen on top of the master-detail, it sets activeConversationId
 * in ChatContext and pops back to the home (master-detail) route, so the
 * right pane updates in place.
 */
export { ChatScreen as ChatScreenRouter } from './ChatScreen';
