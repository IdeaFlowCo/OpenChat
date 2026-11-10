# Copy / select / edit audit — 2026-11

**Trigger (Jacob, iPhone):** searching "tea" in Stream, he could not select or copy an entry's text, let alone edit it; opening the original message from the saved entry, he could not copy that either. Request: copy and selection everywhere, on both the native app and the web export (`chat.ideaflow.app/app`), audited thoroughly.

Scope: `apps/mobile` (native iOS/Android and the react-native-web export). The separate `apps/web` client is not covered here.

## How selection works (why the bug happened)

- **Native:** `<Text>` is only selectable with `selectable`. On iOS, a `selectable` Text inside a `TouchableOpacity`/`Pressable` that handles `onPress`/`onLongPress` doesn't get the long-press that starts selection, because the touchable takes it. Those cards need an explicit **Copy** action, plus a **Select text…** sheet for copying part of the text.
- **Web (react-native-web 0.21):** text is selectable by default, but `TouchableOpacity` sets `user-select: none` on itself. Text inside it can only be selected if the Text sets `selectable` (which becomes `user-select: text`). Pressables also fire `onPress` when the user releases after drag-selecting, so press handlers must ignore a non-empty `window.getSelection()`.

## Shared pieces added

| Piece | Purpose |
|---|---|
| `src/utils/copyText.ts` | `copyText()` (expo-clipboard; never throws, returns success), `hasActiveTextSelection()` (web only), `messageCopyText()` (content, else voice transcript) |
| `src/components/CopyButton.tsx` | Inline **Copy** with in-place "Copied" / "Could not copy" confirmation (44 pt target, live region) |
| `src/components/SelectableTextSheet.tsx` | **Select text…**: full text in a selectable `Text`, with **Copy all**. `SelectableTextPanel` is the same content without a Modal, for menus already inside a Modal (on iOS, opening a second Modal while one is dismissing can be dropped) |

No new dependencies (`expo-clipboard ~8.0.8` was already used).

## Inventory

Legend: **Sel** = text selectable in place · **Copy** = explicit copy action · **Edit** = owner can edit from this surface. "web-only" means selectable on web; on native, the card's own gestures win and Copy/Select text… cover it.

| Surface | File | Before (Sel / Copy / Edit) | After (Sel / Copy / Edit) |
|---|---|---|---|
| **Stream entry** (Stream list, Stream search results, chat Context lane) | `components/ThoughtCard.tsx` | No (blocked native + web) / only "Copy link to original" / Yes (tap, "Edit entry") | web-only, and finishing a selection no longer opens the editor; right-click over a selection keeps the browser menu / **Copy text** + **Select text…** in the long-press (right-click) menu / Yes, unchanged |
| **Stream search: Vision result** | `components/VisionNoteCard.tsx` | No / No / No | **Yes** (title, body, tags) / **Copy** button / No: the note lives in Vision and is edited there ("Open in Vision") |
| **Original message** (from a saved entry) | `screens/OriginalMessageScreen.tsx` | No / No / n/a | **Yes** (text and sender line) / **Copy** on every message ("Copy saved message" on the saved one) / n/a (read-only by design) |
| Chat message: human text | `components/MessageText.tsx` in `ChatScreen` bubble | Yes on web; native blocked by bubble long-press / Copy (RN core `Clipboard`, deprecated) / Yes (own) | Same selection / Copy via expo-clipboard + new **Select text…** / Yes |
| Chat message: agent/bot reply | `components/AgentMarkdown.tsx` | No / sheet Copy (raw markdown) / n/a | **Yes** (paragraphs, headings, quotes, code, list items) / Copy + Select text… / n/a |
| Chat message: translated text | `components/TranslatedMessage.tsx` → `MessageText` | Yes / Copy copies the original / n/a | Same: Copy copies the original (deliberate, see below) |
| Chat message: voice transcript | `screens/ChatScreen.tsx` | No / Copy copied empty `content` / n/a | **Yes** / **Copy transcript** when there's no text / n/a |
| Chat message: attachment only (no text) | `components/MessageActionSheet.tsx` | Copy shown, copied "" | Copy hidden when there is nothing to copy |
| Chat link list ("Links · Open or copy") | `components/MessageLinkActions.tsx` | Yes / Copy link / n/a | unchanged |
| Search: message hits | `screens/SearchScreen.tsx` | No (row opens chat) / No / n/a | web-only, and a finished selection doesn't open the chat / **long-press → Select text… sheet** with the full message + Copy all / n/a (open the chat to edit your own) |
| Search: people, conversation previews | `screens/SearchScreen.tsx` | No / No / n/a | Unchanged: names and previews, navigation rows |
| Agent overlay thread | `screens/AgentOverlayScreen.tsx` | No / No / n/a | **Yes** / — / n/a |
| Agent network cards (drafts, matches) | `components/AgentNetworkCard.tsx` | No / No / n/a | **Yes** (title, terms, own intent) |
| Context lane posts | `components/ContextLane.tsx` | Yes / No / Yes (own) | unchanged (already selectable in a plain View) |
| Context drafts / review | `components/ContextDraftCard.tsx` | Yes / No / Yes | unchanged |
| Share-and-pin confirmation | `components/ContextStreamEntry.tsx` | Yes | unchanged |
| Imported chat messages | `screens/ImportedChatScreen.tsx` | Yes (text, original text) / No / read-only import | unchanged; system rows now **Yes** |
| Imported asks, source quotes | `components/ImportedChatParts.tsx` | No | **Yes** |
| Imported person facts and recent messages | `screens/ImportedPersonScreen.tsx` | No | **Yes** |
| People asks (Asks tab) | `components/PeopleAsks.tsx` | No / No / status only | **Yes** (text, evidence, source excerpt) / — / status only |
| Asks: drafts, intentions, stories | `screens/AsksScreen.tsx` | No | **Yes** |
| Ask detail: ask text, evidence quote | `screens/AskDetailScreen.tsx` | No / No / via "Update published version" | **Yes** / — / unchanged |
| Ask detail: source excerpts | `screens/AskDetailScreen.tsx` | No (row navigates to chat) | Unchanged: the row opens the source chat, where Copy exists |
| Shared asks, profile stories | `components/PublishedAsks.tsx`, `components/ProfileAsks.tsx` | No | **Yes** |
| Contact profile headline / status | `screens/ContactProfileScreen.tsx` | No | **Yes** |
| Private notes, standing asks, suggestion evidence | `components/ProfileNoteCapture.tsx` | No / No / delete only | **Yes** / — / delete only (see follow-ups) |
| Private graph: notes, connection source note | `components/PrivateGraph.tsx` | No | **Yes** |
| Story caption | `screens/StoryViewerScreen.tsx` | No | **Yes** |
| Social review items | `screens/SocialReviewScreen.tsx` | No | **Yes** |
| My card / Add-me card headline and status | `screens/MyCardScreen.tsx`, `components/AddMeCardView.tsx` | No / share-link copy / Yes via Profile edit | **Yes** / unchanged / unchanged |
| Link preview card (title, description) | `components/LinkPreviewCard.tsx` | No (whole card opens the URL) | Unchanged (deliberate) |
| Reply quote in a bubble; composer reply/edit bars; conversation-list, banner and forward-picker previews | various | No | Unchanged (deliberate) |
| Secretary quick answers | `screens/SecretaryScreen.tsx` | No (tap edits, long-press removes) / No / Yes | Unchanged (deliberate) |

## Deliberately left alone

- **Truncated previews that navigate** (conversation list, banners, forward picker, reply quotes, composer bars): they open the full message, which has Copy. Making them selectable would fight the row's tap.
- **Link preview cards:** the text belongs to a third-party page and the card opens it. The link itself can be copied from the message's "Links · Open or copy".
- **Secretary quick answers:** tapping already opens an editable field (select and copy there), and long-press is "remove". Adding a third gesture would be confusing.
- **Translated text Copy** still copies the original message. Copying the translation needs the translation state lifted out of `TranslatedMessage`. On web, the translated text is selectable in place.
- **Vision notes are not editable from OpenChat.** They are Vision-owned (OpenChat saves chat messages to Vision, not Stream entries), and the server has no Vision write bridge. Adding one would be a new cross-app write path with its own security review. "Open in Vision" stays the edit path.

## Server

No server change. `PATCH /api/thoughts/:id` (`apps/server/src/routes/thoughts.ts`) is already owner-only (`MATCH (u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought {id: $id})`, 404 otherwise). The Stream editors (`ThoughtsScreen`, `ConversationEntryEditor`) already use it, including from search results.

## Follow-ups (not in this change)

- Private people notes are delete-only. An owner edit needs a private-note update route (check `privateGraph` routes) and UI.
- Copy the translation (not the original) when a translation is showing.
- PR #157 (`feat/message-capture-20261009`) adds `SavedMessagesScreen`. If it lands, its entry text should use `selectable` and `CopyButton` / `SelectableTextSheet` from this change.

## Tests

- `apps/server/test/copySelect.mobile.test.ts` covers the helpers; ThoughtCard Copy text / Select text… / Edit / web selection-vs-tap / web right-click; VisionNoteCard selectable + Copy; OriginalMessageScreen selectable + per-message Copy; MessageActionSheet Copy (expo-clipboard), Select text…, Copy transcript, and no empty Copy.
- `apps/server/test/contactProfileDoors.mobile.test.ts`: long-press on a message search hit shows the full message selectable.
