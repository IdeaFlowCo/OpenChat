# Unlinked and OpenChat: shared account and inbox

Unlinked is the professional network; OpenChat is its messenger. Both use the
same Ideaflow issuer/subject. Opening either app needs no separate registration.
App-local records are created as needed; an OpenChat account does not publish an
Unlinked profile, import contacts, or grant agent access to another person.

The eventual Unlinked web Messages surface must use OpenChat's existing
conversation IDs, membership, history, unread state, realtime transport and
sending rules. It must not create a second message store or synchronize copies.
This release opens the shared inbox composer in OpenChat; embedding that inbox
inside Unlinked is a separate client surface.

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
