# Unlinked → OpenChat compose contract

Canonical entry: `https://chat.ideaflow.app/app/?intent=compose&source=unlinked`.
The legacy OpenChat host accepts the same query. Optional `profile` is one
URL-encoded canonical **public** `https://www.unlinked.ai/people/<id>` URL:
1–480 characters in `[A-Za-z0-9._~%-]`; valid percent encoding; no decoded
slash, whitespace, query/fragment, backslash, controls or dot segments.
No private origin, query/fragment, profile name, imported email or other payload
is accepted. The Unlinked caller must omit `profile` for private-only profiles.
OpenChat never fetches the profile or treats its URL as identity proof.

Optional `card` is an existing real OpenChat card's 24-alphanumeric token.
OpenChat resolves it through its own card service; invalid/deleted cards show
an honest error and require selecting a contact. A profile URL alone leaves
no recipient selected. No account linking or friend request occurs.

The entry is retained locally for up to one session-length hour across sign-in
and onboarding, then opens an unsent editable draft. The sender chooses the
recipient and explicitly presses **Send message**. No automatic sending.
Cancel discards the incoming entry. Existing `/c/<token>` links are unchanged.
