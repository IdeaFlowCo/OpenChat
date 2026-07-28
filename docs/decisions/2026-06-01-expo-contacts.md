# Decision: defer expo-contacts integration until phone-number sign-in lands

> **Ticket:** OpenChat-ap3
> **Date:** 2026-06-01
> **Status:** Recommendation written; awaiting Jacob sign-off then close
> **Owner:** Jacob Cole

## Question

Should OpenChat mobile request iOS Contacts access to power friend-discovery?

## Recommendation

**Defer.** Don't install `expo-contacts`, don't ship a "Find friends" flow. Block this decision on OpenChat-xf4 (phone-number sign-in). Re-evaluate when that ships or is explicitly declined.

## Why

### 1. Decline rate annihilates value

iOS Contacts permission decline rate from independent telemetry runs **40–60% on cold prompts**. On top of that, iOS 14+'s "Limited Access" mode further fragments matching — users grant access to *some* contacts, your app sees only those, the match rate per user goes from "X% have OpenChat" to "X% × % shared × % matched on signal".

### 2. Match signal collapses without phone numbers

OpenChat today identifies users by email (Google OAuth, Apple SIWA email-relay). Most iOS Contacts entries have **a phone number, often no email**. Match rate against email-keyed users in a typical user's address book: ~5–10%.

Phone-number sign-in (OpenChat-xf4) would change this. With phone-keyed users, match rate jumps to 40–60% of address-book entries (the ones who happen to be OpenChat users).

### 3. The privacy cost is real even at low value

Even if we hash phone numbers client-side, asking for Contacts conditions every install around a permission prompt many users will reflexively decline. That decline carries over to future asks (push, microphone) by training the user to say no to OpenChat permission dialogs.

### 4. We have working alternatives

- **QR add-user** (OpenChat-wtb) — peer-to-peer, no permission needed
- **Per-group invite QR + universal link** (OpenChat-240, OpenChat-84u.1 — shipped this session) — share a link in any messaging app
- **User search + conversation creation** in /m/, /d/, native (`GET /api/chat/search`, then `POST /api/chat/conversations` with `participantIds`) — works for any user who can find the other account
- **Search screen** with autocomplete over `/api/chat/contacts` — works for already-connected users

These cover ~80% of the IRL onboarding moments (meet someone, scan their QR, or get their email).

## If we EVER decide to ship it (after xf4)

Build with the patterns below — none are decided yet, this is what a future implementation should look like:

1. **Contextual permission ask** — fire `Contacts.requestPermissionsAsync()` *only* when the user taps a "Find friends" entry point, NEVER at app launch. Pre-prompt with a soft-ask sheet (matches OpenChat-9mo's `PushSoftAsk` pattern) explaining what we'll see and how matching works.
2. **Client-side hashing** — sha256 of E.164-normalized phone numbers. The plaintext numbers NEVER leave the device.
3. **Batched server lookup** — `POST /api/chat/contacts/match { hashes: string[] }` returns the subset that are OpenChat users. No client-visible mapping of hash → identity — server returns only matched user IDs.
4. **Explicit add** — matches show as cards with "Send invite" or "Start chat" actions. NEVER auto-friend.
5. **No address-book persistence on server** — hashes used for the match query only, not stored. Matches are stored as `KNOWS` edges (one-way) in Neo4j.
6. **Privacy label** — flip "Contacts" to YES in `docs/app-store-privacy-labels.md` (currently NO). Update privacy policy.

## Decision triggers

Re-open this ticket when ANY of these is true:

- OpenChat-xf4 ships phone-number sign-in
- We get ≥3 user requests for "find people I already know"
- A pivot to a phone-book-style growth loop becomes strategic

## Action: close `ap3` as "Recommendation written; deferred to xf4 outcome"

Once Jacob signs off (in a future session), the ticket closes with this doc as the deliverable. No code changes ship from this ticket.
