/**
 * HomeScreen — NATIVE / narrow-web shim (OpenChat-601).
 *
 * Registered at the "Conversations" route key in the ChatsNavigator stack.
 * On native and on web viewports <900px this is the actual home — a
 * straight re-export of ConversationsScreen. The .web.tsx sibling handles
 * the responsive swap to MasterDetailLayout for desktop-width browsers.
 *
 * Per Codex review 2026-06-01: every .web.tsx imported by shared code
 * needs a native sibling, otherwise Metro fails on iOS / Android build.
 * This shim satisfies that constraint.
 */
export { ConversationsScreen as HomeScreen } from './ConversationsScreen';
