/**
 * KeyboardShortcutsScreen — NATIVE shim (OpenChat-601).
 *
 * Registered in the ChatsNavigator route tree so navigation type-checking
 * can address it from anywhere, but never reachable on native (the route
 * is only ever opened from the desktop master-detail via Cmd-/). On
 * mobile this just renders nothing — defensive, in case someone wires up
 * an accidental navigation.navigate('KeyboardShortcuts') call.
 *
 * The real cheat-sheet UI lives in KeyboardShortcutsScreen.web.tsx.
 */
export function KeyboardShortcutsScreen() {
  return null;
}
