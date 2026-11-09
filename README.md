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

## Saved people

From **Chats**, open **People**, then **Friends** to see **Saved people**.
The list loads all pages automatically and shows how many records have loaded.
**Incomplete** means loading has stopped before the end; **Retry loading people**
continues after a failure. Previously displayed people stay visible during an
incomplete refresh. A final **N saved people** count covers your saved private
person records, not OpenChat accounts or a verified total of your device contacts.

Choose **+ Add person**, enter a name, and **Save privately**; **Private profile**
opens the record's notes and asks. Saving a person does not invite or notify them.
Agent import, pagination and durable-state contracts are in the
[private graph reference](docs/private-graph.md).

## Messages and Stream

On web, **Enter** sends a chat message and **Shift+Enter** inserts a newline.
When hashtag suggestions are open, Enter or Tab selects the highlighted tag;
Shift+Enter still inserts a newline. Native keyboard return inserts a newline;
use the send button to send. Long-press a message for its actions, or right-click
on desktop web to open the same menu.

If message history fails to load, the chat shows an error and **Retry** instead
of an empty-chat prompt. Tap **Retry** to reload; previously loaded messages stay
visible during transient failures. Reconnecting also reloads the open thread.
If access is denied or the conversation is unavailable, cached messages are
cleared instead.

For offline reading and queued sends, see [Offline chat](docs/offline-chat.md),
including setup, delivery states, account cleanup, and connection requirements.

Open **Stream** from Chats for personal entries. The search bar filters text and
tags. Its visible **Create** action opens an editable entry using your search
text, even when nothing matches; with empty text it opens a blank entry. The
**+ Create** button also opens a blank entry. Tap **Save entry** or leave the
editor to save; tap an entry to edit it. New entries are private and unpinned.
Long-press an entry, or right-click on desktop web, for its available actions.

A chat's **Stream** header button and **Stream for this chat** menu open the same
collection as **Context**. See [conversation content](docs/conversation-content.md)
for filters, audience labels, private entries, sharing and source access. See
[Context intention lifecycle](docs/context-intention-lifecycle.md) for tracking
and linking shared Ask/Offer posts and managing their linked projections.

Hashtag suggestions combine your own tags with tags from hashtagged messages
and tagged replies in chats you currently belong to; other people's private
captures never contribute. Saved-message entries have an **Original message**
door: it highlights the source with up to five nondeleted messages before and
after, and offers **Open chat**. Current membership is required; saving an entry
does not grant source access, and deleted or inaccessible sources are unavailable.
**Copy link to original** in an entry's actions gives a shareable
`https://chat.ideaflow.app/app/original/<entryId>` link; opening it re-checks
membership the same way.

Search matches tags with or without the `#`, so `#event` finds entries saved by
replying `#event` to someone's message. The chevron on each entry (or
**Collapse entry** in its actions) folds it to one line. Collapse is your own
saved preference: it applies in your Stream and every chat Stream, on every
device, and never changes what others see. Tap a collapsed entry to expand it.
**Compact view** (on by default, remembered per device) shows the first four
lines of entries with at least six newline-separated lines or 400 characters
until **Show more**; **Show less** folds them again. It applies with or without
a search. Both controls affect Stream entries only, including those in the
combined conversation feed; Context posts are unchanged.

## Assistant context and Save to Vision

In your private, two-person **OpenChat Agent** chat, tap **Context: Universal**
above the composer to switch to **This chat only**. The choice applies to
subsequent sends in the current session until changed; changing it does not erase
earlier context. Group assistant turns always stay within that conversation.

Open a text message's **Actions**, then **Save to Vision** for the whole text,
or paste or dictate an exact excerpt and choose **Save selected text to Vision**.
This creates a private copy and leaves the source chat unchanged. If prompted,
choose **Connect Vision**, compare the code on the Ideaflow approval page,
sign in with the same Ideaflow ID, and explicitly allow Vision write. Return
and choose Save again; the selection stays in the sheet. **Saved to Vision**
confirms a destination receipt and offers **Open Vision**.

If **Save outcome unknown** appears, search Vision for the displayed
`openchat-save:…` marker before creating another copy. A missing search result
does not prove nothing was saved. A returned uncertain receipt offers
**Save a new copy…**, followed by a duplication warning and **Create new copy**;
some unknown-outcome alerts show only the marker and warning, without copy
actions. **Save receipt unavailable** also means the note may exist.
Only a proven rejection before dispatch offers **Refresh and review**, then
**Start new save attempt**; review the refreshed source first. These actions
retain your selection and never automatically resend an uncertain save.

This source change has separate live acceptance gates; see the
[scope, save contract and release restrictions](docs/shared-capabilities-control.md).

## Chat emoji and Tickle

With nothing typed, the chat's emoji (default 🍓) sits where **Send** is: tap to
send it, hold to send it bigger. **More › Chat emoji** changes it for everyone
in the chat. **More › Tickle <name>** (or Tickle from someone's message) nudges
them with a buzz, a shake and a line in the thread. See
[docs/emoji-send-and-tickle.md](docs/emoji-send-and-tickle.md).

## Unexpected-error recovery

If OpenChat shows **Something went wrong**, the full error message is selectable.
Tap **Copy error** to copy the message, boundary scope and stack (when available)
for diagnosis. The screen confirms whether copying succeeded; if it fails,
select the error text to copy it manually. Tap **Try again** to retry drawing
the screen.

## Notifications and conversation links

Native push requires notification permission on a physical device. Tapping a
notification opens its conversation; in-app message banners open **Chat**, and
Context links open **Context**. A destination received during startup waits for
navigation, sign-in and onboarding to finish. Foreground chat alerts are suppressed
while that chat is focused and connected, or when the conversation is muted;
viewing Context does not suppress them.

Browser background push is not implemented (follow-up **OpenChat-7o4h**).
Physical iPhone APNs/Expo delivery still needs a device smoke check; the mocked
notification tests do not establish delivery reliability. Context refresh and
quiet delivery are described in [Context back-channel](docs/context-backchannel.md).

## Vision in your Stream and chats

When you are signed in with Ideaflow ID and use Vision, searching **Stream**
also searches your Vision notes. **From OpenChat** (the default) shows notes
that came from OpenChat alongside your Stream entries, newest first. **All my
notes** searches all of your Vision notes. Each Vision result offers
**Open in Vision**; **Load more** fetches the next page. If Vision does not
answer, Stream shows **Vision unavailable — showing OpenChat Stream only** and
searches your Stream alone.

A message you send from Vision shows **from Vision** under it in your own copy;
recipients see an ordinary message. Replies to it appear back in Vision. Your
OpenChat Agent can also read your own Stream when you ask it in your private
agent chat.

Server configuration (production compose forwards these; never commit values):

| Variable | Purpose |
|---|---|
| `VISION_MESSAGING_SECRET` | Bearer secret (≥32 chars) Vision's server uses for `POST /api/vision/session`. Unset means the route answers 503. |
| `VISION_API_BASE` | Vision API origin (https) that receives replies at `/openchat/replies`. |
| `OPENCHAT_VISION_SECRET` | Bearer secret (≥32 chars) OpenChat sends with each reply. Reply delivery stays idle without it and `VISION_API_BASE`. |

Stream search over Vision also needs the existing `IDEAFLOW_BUILTIN_CLIENT_ID` /
`IDEAFLOW_BUILTIN_CLIENT_SECRET`. See the
[Vision stream bridge contract](docs/shared-capabilities-control.md#vision-stream-bridge-openchat-vwgq9-12-openchat-3kr9).

## Message with OpenChat from Unlinked

An Unlinked **Message** link opens the person's normal conversation, reusing
any existing thread. Write and send in the usual chat box; opening the link
sends nothing. **New message** opens the standard recipient picker.

Accepting an Unlinked connection request creates or reuses one direct chat for
both people in OpenChat and Unlinked Messages, visible on the next chat-list
load. A new chat is empty: acceptance sends no message, push or email and adds
no unread notification. It does not grant OpenChat friendship or friends-only
Context access. Existing blocks and local declined/removed connections suppress
new acceptance synchronization. See the [accepted-connection contract](docs/unlinked-accepted-connections.md)
for synchronization and privacy rules.

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
