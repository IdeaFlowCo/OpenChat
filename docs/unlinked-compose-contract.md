# Unlinked and OpenChat: shared account and inbox

Unlinked is the professional network; OpenChat is its messenger. Both use the
same Ideaflow issuer/subject. Opening either app needs no separate registration.
App-local records are created as needed; an OpenChat account does not publish an
Unlinked profile, import contacts, or grant agent access to another person.

Unlinked's integrated web Messages surface uses OpenChat's existing
conversation IDs, membership, history, unread state, realtime transport and
sending rules. It must not create a second message store or synchronize copies.
Member profile actions open the composer inside Unlinked; standalone OpenChat
continues to expose the same inbox.

## Profile entry

`https://chat.ideaflow.app/app/?intent=compose&source=unlinked` accepts an optional
canonical public `https://www.unlinked.ai/people/<id>` in `profile`, and an
optional existing 24-alphanumeric OpenChat `card` token. Unknown or repeated
parameters invalidate the entry. Private profile fields, names, email addresses,
message bodies and caller-selected recipient IDs are never accepted in the URL.

A card is resolved by OpenChat's card service. Otherwise a public profile is
resolved by authenticated `POST /api/unlinked/recipient` with `{profile}`. The
OpenChat server calls the fixed Unlinked `/api/messaging/v1/recipient` endpoint
with `{profileId}` and its dedicated `UNLINKED_MESSAGING_SECRET`. Unlinked checks
the live published profile, its live owner and its exact active Ideaflow binding.
Only this confidential response can identify the recipient; the URL is not proof.
The secret and issuer/subject never reach the browser. Redirects are rejected;
requests time out and are rate limited. Missing configuration fails closed.

A member's shared inbox is materialized lazily with the unique issuer/subject
key already used at sign-in. The first verified login fills its missing email;
it does not replace the inbox or its conversation history. Provisioning an inbox
does not sign its owner in, mark them online, add contacts or send a message.
Existing mapped OpenChat users retain their ID. Legacy accounts without a shared
identity binding still follow the existing verified sign-in/linking policy;
imported names/email never merge identities.

The composer shows **Message [name]** with a blank draft and no recipient search.
An unclaimed profile offers **Get an invite link**, opening the sender's existing
card sharing screen. An absent/revoked profile is unavailable; a service outage
shows **Try again**, never an incorrect invitation or an unrelated recipient.
Generic compose (no profile/card) retains manual contact selection.

## Continuation and sending

Incoming entries survive sign-in and device onboarding for up to one hour and
are consumed by capture revision. A newer link resets the displayed draft and
recipient; stale asynchronous results cannot route a message. Draft edits are
not persisted in the incoming-entry record. The sender explicitly presses
**Send message**, using the existing direct-conversation service, which reuses
the same conversation. A failed send retains the draft and conversation; duplicate
taps are suppressed. Cancel sends nothing. Existing `/c/<token>` links remain.

Deploy the confidential Unlinked resolver and configure the same random service
secret on both servers before enabling the new OpenChat client. Remove that
secret to disable resolution without widening recipients. No agent grant gains
messaging or identity lookup capability from this change.

## Integrated Unlinked inbox

`https://www.unlinked.ai/messages` embeds the canonical `/app/?embed=unlinked`
client. It uses the existing API, sockets, conversations and read state. The
embedded presentation adopts Unlinked colors and hides the product tab bar;
standalone and native OpenChat retain their usual presentation.

The Unlinked browser session is exchanged server-to-server at
`POST /api/unlinked/session` with the dedicated messaging secret and the live
owner's exact Ideaflow issuer/subject. The resulting 10-minute JWT travels only
in POST bodies and an exact-origin, exact-window, nonce-bound `postMessage`
handshake. It stays in iframe memory, never overwriting standalone OpenChat
credentials. Renewals recheck the Unlinked session and live ownership. Framing is
allowed only by self and `https://www.unlinked.ai`. No conversation or message is
created by opening the inbox. LinkedIn channel options are plan-only in
[linkedin-messaging-plan.md](linkedin-messaging-plan.md).

The embedded receiver accepts the exact `embed=unlinked` presentation flag alongside the compose query. It still rejects unknown/repeated parameters and resolves the public profile on the server before choosing a recipient. Embedded pending compose state stays in memory per frame, separate from standalone compose storage.
