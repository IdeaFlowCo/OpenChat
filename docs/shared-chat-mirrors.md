# Shared chat mirrors and link resources

An [imported chat](imported-chat-mirrors.md) is its owner's private, read-only
copy of a chat from another network. The owner can share **one** such mirror
into **one group conversation they own**. The members of that group then see
the mirrored messages next to the group's own messages, and the group keeps
every shared link as a lasting resource.

Tracked in beads `OpenChat-c8to`. The first use is a three-person group whose
iMessage thread is mirrored into its OpenChat group.

This is deliberately narrower than the
[direct-chat continuity proposal](imported-chat-claim-continuity.md): there is
no identity claim, no copy, and no message becomes an OpenChat message.

## What members see

| In the conversation | What it is |
|---|---|
| **Unified · OpenChat · iMessage** switch | Shown only when a mirror is shared into the conversation. *Unified* lists both in time order; the other two show one side. The third position carries the network's name. |
| Mirrored message | Outlined, labelled with the sender's name as the sharer knows it and the network. Read-only: no reply, reaction, edit, read receipt, notification or unread count. |
| **Links** tab | Every address shared in the conversation or its mirror, once each: a guessed kind, suggested tags, who first shared it and where. |
| **Edit tags** | Any member may change the tags or the kind. The change is shared with the conversation and replaces the guess. |
| **Save** | A member's own mark. Others see only how many members saved a link. |

The composer always writes OpenChat messages. Nothing is ever sent back to the
other network.

## Who can do what

| Action | Who | Route |
|---|---|---|
| Share a mirror into a group | The mirror's owner, in their own session, when they own the group | `PUT /api/imported-chats/:chatId/shares` `{ "conversationId" }` |
| Stop sharing | Same | `DELETE /api/imported-chats/:chatId/shares/:conversationId` |
| See shares and sync-token state | The mirror's owner | `GET /api/imported-chats/:chatId/shares` |
| Issue or revoke the mirror's sync token | The mirror's owner, in their own session | `POST` / `DELETE /api/imported-chats/:chatId/sync-token` |
| Sync the mirror | Holder of that mirror's sync token | `PUT /api/imported-chats/sync/:chatId` |
| List what is shared into a conversation | A member, in their own session | `GET /api/chat/conversations/:id/sources` |
| Read mirrored messages | A member, in their own session | `GET /api/chat/conversations/:id/sources/:shareId/messages?before=&limit=` |
| List link resources | A member, in their own session | `GET /api/chat/conversations/:id/resources` |
| Edit tags or kind | A member, in their own session | `PATCH /api/chat/conversations/:id/resources/:resourceId` `{ "tags"?, "kind"? }` |
| Save or unsave | A member, in their own session | `PUT /api/chat/conversations/:id/resources/:resourceId/saved` `{ "saved" }` |

"In their own session" means a signed-in person. Agent keys, the shared
Ideaflow connector, connector delegations and embedded sessions get `404` on
the member routes, and on sharing and token routes. Refusals are `404`, never
`403` (the app signs a person out on 403). Responses are `no-store`.

Access is checked on every read against live membership:

- the reader must be in the conversation;
- the share must exist;
- the sharer must still be in the conversation, so a mirror never outlives its
  owner's membership.

Unsharing, deleting the mirror, or deleting the owner's account ends member
access at once. Link resources already collected stay with the conversation.

## What is stored where

| Data | Where | Visible to |
|---|---|---|
| Mirrored messages, participant names | `OpenChatImported*` nodes, owned by the sharer (unchanged from private imports) | The sharer; members of the group it is shared into, while shared |
| The share | One `(:OpenChatImportedChat)-[:SHARED_INTO]->(:Conversation)` relationship | n/a |
| Sync token | Only its SHA-256, on the mirror node | Nobody; the token is shown once when issued |
| Link resources | `(:ConversationResource)`: address, page title and description from the public page, kind, tags, first/last share time, first sharer's name, source networks, and the ids of the messages it appeared in | Members of the conversation |
| Saved marks | `(:User)-[:SAVED_RESOURCE]->(:ConversationResource)` | That member; others see a count |

Never shared with members: asks, profile facts, the owner's ask statuses,
source keys, source message ids, pre-edit text, and every other imported chat.

Mirrored messages are still not `Message` nodes, so sockets, push, unread
counts, search, the OpenChat Agent, Context, matching and discovery do not see
them. The link collector reads their text to find addresses; that is the only
new reader.

## Link resources

Resources are on only where `Conversation.resourcesEnabled` is set; sharing a
mirror into a group sets it. They are collected when a member opens **Links**,
from the conversation's messages and the mirror, so the send path is untouched.

- **One entry per page.** `http`/`https`, `www.`, a trailing slash, a fragment
  and tracking parameters do not make a new entry.
- **Kind and suggested tags** come from the address and the page's public
  title and description (fetched through the same guarded fetch as link
  previews: public addresses only, size and time limits). Message text is not
  used for the guess. Kinds: paper, article, reference, person, tool,
  organization, community, code, video, document, post, event, link.
- **Edits win.** Once a member edits tags or kind, later guesses never replace
  them. The original suggestion is kept beside the edit.
- **Tags** are NFKC-normalised, lower-cased, letters/numbers/hyphen/underscore,
  up to 40 characters, at most 12 per link.

## One-chat sync token

A companion keeps a mirror current with `PUT /api/imported-chats/sync/:chatId`
and that mirror's token (`Authorization: Bearer ocm_…`).

- The token names exactly one mirror. The payload's `source` must match that
  mirror, or the request is refused.
- Write-only: no read route accepts it.
- It can add or update participants and messages only. A payload carrying asks
  or profile facts is refused.
- The body (same schema as the [import API](imported-chat-mirrors.md#import-api))
  is parsed only after the token is accepted. `?dryRun=1` writes nothing.
- Issuing a new token replaces the old one. Revoking leaves the mirror intact.

## iMessage companion

`scripts/imessage-thread-mirror/mirror.py` mirrors **one** iMessage thread. See
its [README](../scripts/imessage-thread-mirror/README.md). In short:

- opens the Messages database read-only and reads only the thread whose row id
  **and** guid both match its local config;
- uploads text messages, and placeholders for attachments and unsent messages;
- never uploads phone numbers or email addresses (each person is a keyed hash;
  names come from the local config), attachments, tapbacks, group events, or
  any other thread;
- logs counts only.

It is not a general capture tool. The separate tag-driven iMessage capture in
PR #157 remains unmerged and under its own review hold.

## Invite previews

An invite link's preview (`/i/:token`) no longer names the group or its size:
the static `<title>`, description and Open Graph tags are neutral, the page is
`noindex`, `no-store` and sends no referrer. The group's name is shown in the
page body and the tab title to the person who opened the link.

**Open in OpenChat** uses the app's link scheme. For a visitor without the app
that tap used to do nothing; the page now continues to **Join on the web** when
it is still in front a moment later.
