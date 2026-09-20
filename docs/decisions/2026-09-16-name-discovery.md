# Name discovery with private email

## Question

During the early beta, should OpenChat require a complete email to find a
person, or should people be searchable by display name like Facebook?

## Decision

Accounts are searchable by display name by default. A profile can choose one
of three discovery modes:

- **Everyone by name** (`name`, default): partial display-name and exact-email
  lookup are allowed.
- **Only people with my email** (`email_only`): only a complete exact email can
  find the account.
- **Nobody** (`hidden`): neither name nor email search nor the public user-QR
  landing page returns the account.

Discovery responses never return an email address. They contain only the
stable local user id, display name, avatar, presence/status fields, and bot
indicator needed to choose a recipient and start a DM. Existing conversations,
local ids, memberships, and message history are unchanged.

Display names may not contain `@`. At startup, an idempotent privacy repair
replaces blank and legacy email-like names with `OpenChat member`; sign-in
providers use the same neutral fallback when they do not supply a real name.
This closes the historical email-as-name fallback without changing identity.

Block edges apply consistently to people search, direct and group creation,
group-member additions, message sends (socket and REST fallback), and message
forwards. Creation/member/forward endpoints return a generic unavailable or
not-found response; message sends are silently acknowledged but dropped on
both transports so a caller cannot use them to probe who blocked them.

OpenChat does not currently have durable usernames. Search and participant
pickers disambiguate duplicate names with a short local-id prefix, and mention
resolution skips ambiguous display-name matches instead of notifying the wrong
person.

This default intentionally applies to existing beta accounts as well as new
ones. The product is still in early beta, and the explicit product direction is
to favor Facebook-like name discovery now; users can immediately opt down from
Edit profile.

Profile photos use the existing `avatarUrl` field and presigned object-storage
upload path. Edit-profile screens now expose that capability rather than
creating a second media model. The current object-storage bucket serves these
avatar URLs publicly; choosing a photo is optional, including for hidden users.

## Rationale

Name search reduces early-beta connection friction and matches the expected
social-network interaction. Keeping email out of every discovery projection
prevents lookup results from becoming a public email directory. Per-profile
controls retain a meaningful privacy escape hatch without making privacy depend
on a privileged caller role.
