# OpenChat

A monorepo for the OpenChat application.

## OpenChat Surface Map

| Path | What it is | Framework | Ships to | Status / Activity |
|------|-----------|-----------|----------|-------------------|
| `apps/mobile` | Single product client | React Native 0.81.5 + Expo (`react-native-web`) | Native iOS (TestFlight) + Responsive web (`/app`) | **CANONICAL** (High: 63 commits in 60d) |
| `apps/web` | Frozen legacy client | React + Vite (no RN) | Nowhere (migration reference only) | **LEGACY** (Low: 14 cross-cutting commits in 60d) |
| `apps/desktop` | Tauri window around the live `/app` client (same origin/auth/socket; see its README) | Tauri + Rust | macOS `.dmg` via GitHub Releases | **CANONICAL** (active in main) |
| `apps/server` | Shared backend | Node.js / Express + Socket.IO + Neo4j | GCP Prod (see [domain rollout](docs/chat-domain-rollout.md)) | **CANONICAL** (Moderate: 52 commits in 60d) |
| `apps/mcp-server` | Agent tools bridge | TypeScript (Node) | Claude local / connector | **CANONICAL** (Low: 8 commits in 60d) |
| `infra/` | Production deployment | Docker / bash scripts | GCP Prod (Instance `noos`) | **CANONICAL** |

> **Note:** `apps/mobile` is the singular product client for both native mobile and responsive web. `apps/web` is entirely legacy and retained only for history and migration reference.

## Messages and Stream

On web, **Enter** sends a chat message and **Shift+Enter** inserts a newline.
When hashtag suggestions are open, Enter or Tab selects the highlighted tag;
Shift+Enter still inserts a newline. Native keyboard return inserts a newline;
use the send button to send. Long-press a message for its actions, or right-click
on desktop web to open the same menu.

If message history fails to load, the chat shows an error and **Retry** instead
of an empty-chat prompt. Tap **Retry** to reload; previously loaded messages stay
visible during transient failures. Reconnecting also reloads the open thread.

Open **Stream** from Chats, or **Stream** in a chat's header for **Chat Stream**.
The search bar filters text and tags. Its visible **Create** action opens an
editable entry using your search text, even when nothing matches; with empty
text it opens a blank entry. The **+ Create** button also opens a blank entry.
Tap **Save entry** or leave the editor to save; tap an entry to edit it.
New entries are private and unpinned. Creating in Chat Stream keeps the entry
associated with that chat without sharing it. In Chat Stream, explicitly
**Pin to chat** to share an entry with participants.

Hashtag suggestions combine your own tags with tags from hashtagged messages
and tagged replies in chats you currently belong to. Chat Stream restricts
the shared suggestions to that chat; other people's private captures never
contribute. Long-press a Stream entry, or right-click on desktop web, for its
available actions. Saved-message entries have an **Original message** door:
it highlights the source with up to five nondeleted messages before and after,
and offers **Open chat**. Current membership is required; saving an entry does
not grant source access, and deleted or inaccessible sources are unavailable.

## Notifications and conversation links

Native push requires notification permission on a physical device. Tapping a
notification opens its conversation; in-app message banners open **Chat**, and
Context links open **Context**. A destination received during startup waits for
navigation, sign-in and onboarding to finish. Incoming chat alerts are suppressed
while that chat is focused and connected, or when the conversation is muted;
viewing Context does not suppress them.

Browser background push is not implemented (follow-up **OpenChat-7o4h**).
Physical iPhone APNs/Expo delivery still needs a device smoke check; the mocked
notification tests do not establish delivery reliability. Context refresh and
quiet delivery are described in [Context back-channel](docs/context-backchannel.md).

## Message with OpenChat from Unlinked

An Unlinked **Message** link opens the person's normal conversation, reusing
any existing thread. Write and send in the usual chat box; opening the link
sends nothing. **New message** opens the standard recipient picker.
See the [Unlinked compose contract](docs/unlinked-compose-contract.md) for
accepted profile context, card recipient resolution, and sign-in return rules.

## Create a World Issue Tracker board

Open **OpenChat Agent** from Chats and ask it to create a public World Issue
Tracker board, giving the board's name and an optional description, location,
or website URL. The agent checks existing boards first so you can reuse a match,
then asks you to confirm the name and attribution before creating it. It returns
the board link, or an existing board when World Issue Tracker reports a duplicate.

You need an OpenChat session, but no World Issue Tracker sign-in. Boards created
by anyone other than the configured account owner are anonymous, public, listed,
and owned by no account. The owner can also explicitly ask to create anonymously;
otherwise creation uses the owner's identity. An owner-attributed failure is
reported without retrying anonymously. This tool offers no unlisted or nudge
settings. Creation shares OpenChat's limit of 30 external writes per user per
hour and is also subject to World Issue Tracker's limits; a remote rate-limit
response includes the retry delay when supplied.
