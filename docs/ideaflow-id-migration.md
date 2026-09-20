# OpenChat → Ideaflow ID migration

This app-specific rollout implements the global identity decision recorded in
the private [Global Identity Architecture ADR](https://wikihub.globalbr.ai/@jacobcole/jacobcole/projects/global-identity-architecture)
and its [Noos decision node](https://globalbr.ai/node/wv1Iq1CpnuMkplv2sYCI9):
Ideaflow ID owns authentication, while each application keeps its own stable
user IDs, authorization, data, and sessions.

## Goal

Add centralized Ideaflow sign-in without turning an identity-provider rollout
into an account or session migration. OpenChat continues to own its user IDs,
authorization, conversations, and application sessions. Ideaflow ID supplies a
standards-based external identity.

Existing email/password, Google, Apple, Noos JWT, and OpenChat JWT paths stay in
place during the rollout. Enabling this integration does not invalidate an
already-issued token and does not sign a user out of OpenChat, Thoughtstream, or
any other Ideaflow application.

## Identity and linking contract

The durable external key is the exact pair:

```text
issuer = https://id.ideaflow.app/api/auth
sub    = <Ideaflow ID subject>
```

OpenChat stores that pair as `User.ideaflowIssuer` and `User.ideaflowSub` and
enforces a unique derived `User.ideaflowIdentityKey`. Email is never the
durable cross-application identity key. There are three, deliberately
different, ways an (issuer, sub) pair reaches a `User` node:

### 0. Guarded administrative pre-link (migration batches)

High-confidence existing accounts can be linked before their next login with
`apps/server/scripts/link-ideaflow-identities.mjs`. The input manifest is never
committed and must contain the exact local user ID, current local email, exact
Ideaflow provider subject, canonical issuer, and an assertion that the central
email is verified. The script also rejects duplicate local IDs, duplicate
issuer/subject pairs, local email drift, existing conflicting mappings, and
cross-user identity claims. It is dry-run by default and writes all requested
links in one transaction only with `--apply`.

This path is for an audited migration assembled from both authoritative
databases. It does not turn email into an identity key and does not permit
runtime email auto-linking. Existing sessions and legacy login methods are
untouched. Accounts that cannot meet every pre-link proof requirement use the
authenticated linking flow below.

### 1. Explicit, authenticated linking (Settings → Connect Ideaflow ID; fallback)

An already-signed-in OpenChat user completes the Ideaflow ID Authorization
Code + PKCE flow from their account settings. Their existing OpenChat session
is the linking proof — the verified Ideaflow ID email does **not** need to
match the OpenChat account email. This is now only the fallback: it forces
`prompt=login` and requires a fresh `auth_time` (within 120 s of the attempt's
start) so a signed-in OpenChat session never authorizes binding whichever
Ideaflow session happens to be open, and it refuses privileged accounts. The
server:

1. Requires a valid OpenChat session (`requireAuth`) and addresses the target
   `User` node by `req.user.userId` — never by email, and never by creating a
   new node. An already-authenticated caller can only ever bind or reuse their
   own existing node.
2. Records a one-use, ten-minute server-side linking transaction at initiation,
   bound to the exact OpenChat user, bearer session, OIDC state/nonce, and PKCE
   challenge. Account switching, token replacement, replay, expiry, or a
   nonce/verifier mismatch fails before provider exchange.
3. Still requires a verified ID token (`email_verified: true`, correct issuer,
   audience, expiry, nonce) — only the email-matching requirement is dropped.
4. Refuses (HTTP 409) if this exact (issuer, sub) pair is already mapped to a
   *different* OpenChat user.
5. Refuses (HTTP 409) if the current user already carries a *different*
   Ideaflow ID mapping.
6. Is idempotent if the current user is already bound to exactly this
   identity.

The bind acquires a write lock on the target `User` before reading its current
mapping and performs the read, ownership check, and write in one managed Neo4j
transaction. Concurrent attempts to bind different subjects to the same user
therefore cannot overwrite one another.

This is the only path that can link an existing legacy OpenChat account to an
Ideaflow ID identity whose email doesn't already match. It is implemented by
`bindIdeaflowIdentityToUser` in `apps/server/src/routes/auth.ts`.

### 2. Unauthenticated sign-in (`Continue with Ideaflow` on the login screen)

With no OpenChat session yet, the server resolves sign-in conservatively,
implemented by `resolveIdeaflowSignIn`:

1. **Existing durable mapping** — if this (issuer, sub) is already mapped to a
   `User`, sign that user in. No email comparison is needed or performed.
2. **No mapping, but a local email match** (code-d96, seamless accounts) — the
   ID token's email is already required to be the JSON boolean
   `email_verified === true`. The match is a *counted*, case-insensitive
   lookup (never `LIMIT 1`; no dot/plus normalization). Then, identical to the
   Noos resolver because both apps share one `:User` node:
   - more than one match, a match already mapped to another subject, or a
     privileged (`role` other than `user`) account → refused (`link_required`,
     `already_linked`, `needs_admin_proof`);
   - a passwordless account **created by a Google sign-in whose Google email was
     verified** (`signupProvider` `google`/`google-ios`, `googleEmailVerified
     === true`, `googleSub` present) → linked automatically (`via: google-proof`);
   - an account with a password → HTTP 409 `confirm_required` with an opaque
     `confirmId` (held only by the starting tab) and a masked email; the person
     enters that account's password once (`POST /api/auth/ideaflow/confirm`) and
     the identity is bound (`via: password`). At most 5 attempts per check and
     10 failures per account per 15 minutes, single use, 10-minute expiry,
     re-validated (still exactly one unmapped, unprivileged, password account)
     right before binding. Attempts are charged to the account up front, so
     concurrent guesses cannot exceed the cap. The password is judged by Noos's
     own login endpoint (`NOOS_URL`), the only password verifier in the shared
     graph. `NOOS_URL` must be set in production and be https or loopback; if
     Noos is down, rate limiting or unconfigured the check answers 503
     `confirm_unavailable` and the attempt is **not** counted (up to 5 refunds per
     check; only Noos 400/401 count as a wrong password);
   - anything else (Apple/bridge/legacy accounts with no independent proof) →
     `link_required`; the person signs in another way and uses Settings →
     Connect (path 1).
3. **No mapping, no local email match** — this identity has never been seen.
   Whether a brand-new `User` may be created from it is gated by
   `IDEAFLOW_ID_ALLOW_NEW_USER_CREATION` (see Cohort gate, below). The default
   is to refuse (HTTP 403) rather than silently mint an account.

Ambiguous email matches (more than one local account with that email) are
treated identically to a single match: link required, never auto-resolved by
picking one.

After either path succeeds, OpenChat mints its ordinary seven-day application
JWT (unauthenticated sign-in) or simply keeps the caller's existing session
(explicit linking). OpenChat does not use the Ideaflow ID access token as an
OpenChat API token, and does not share provider cookies across domains.

### Use another Ideaflow account

`GET /api/auth/ideaflow/url?switch=1` adds `prompt=login` (only that; no other
`prompt`, `max_age` or `login_hint` from the caller is forwarded). The login
screen shows **Use another Ideaflow account** under the Ideaflow button. Fast
SSO stays the default.

## Cohort gate (production-safe rollout control)

Because verified-email auto-linking was judged too permissive for initial
rollout, every exchange/link/create path is additionally gated by an explicit
cohort allowlist — layered *underneath* `IDEAFLOW_ID_ENABLED`, not instead of
it:

```text
IDEAFLOW_ID_ENABLED=true                       # global kill switch (unchanged)
IDEAFLOW_ID_COHORT_ALLOWLIST=                  # comma-separated emails, or "*"; unset = fail closed
IDEAFLOW_ID_ALLOW_NEW_USER_CREATION=false      # brand-new users from an unmapped identity
```

- `IDEAFLOW_ID_COHORT_ALLOWLIST` is a comma-separated, case-insensitive list of
  emails admitted to the rollout, checked against the ID token's **verified**
  email (`email_verified: true`). The literal value `*` admits every verified
  email — the switch for full general availability. **Unset or empty fails
  closed: nobody is admitted**, even with `IDEAFLOW_ID_ENABLED=true` and valid
  provider credentials. An operator must explicitly opt a cohort in.
- Email here is used **only** as a temporary rollout selector, checked after
  the ID token proves `email_verified: true`. It is never written anywhere as
  a durable identity key — the unique `ideaflowIdentityKey` (issuer+sub) is
  the only durable mapping.
- `IDEAFLOW_ID_ALLOW_NEW_USER_CREATION` additionally gates brand-new `User`
  creation from an unmapped identity with no local email match (unauthenticated
  sign-in path 3, above). Defaults to `false`.
- **The gate applies uniformly, including to already-mapped identities signing
  back in.** An identity that was cohort-approved and linked, then later
  dropped from the allowlist, will stop being able to sign in via Ideaflow ID
  (their legacy OpenChat credentials, Google, Apple, etc. are unaffected).
  This is intentional: the cohort list is a single, predictable rollout
  control an operator can shrink or grow, not a one-time gate that stops
  mattering once someone links. It is enforced in
  `resolveIdeaflowSignIn` for unauthenticated sign-in and, for explicit
  linking, after `POST /ideaflow/link/exchange` verifies the ID token. The
  caller's legacy OpenChat email may be stale or unverified and is never used
  as the rollout selector. `GET /ideaflow/link/url` therefore requires an
  authenticated session and the global kill switch, while the verified IdP
  email controls whether the resulting code may bind an identity.
- Implemented in `apps/server/src/services/ideaflowCohort.ts`
  (`getIdeaflowCohortConfig`, `isCohortEmailAllowed`).

## Provider-side registration

Ideaflow ID production disables dynamic client registration. The confidential
first-party production client was registered through the provider's server-only
procedure on 2026-09-17:

| Field | Value |
| --- | --- |
| client name | `OpenChat Web` |
| client URI | `https://chat.globalbr.ai` |
| redirect URI | `https://chat.globalbr.ai/auth/ideaflow/callback` |
| post-logout redirect URIs | none during additive migration |
| scopes | `openid profile email` |
| token endpoint auth | `client_secret_basic` |
| grant types | `authorization_code` |
| response types | `code` |
| application type | `web` |
| require PKCE | `true` |
| skip consent | `true` (first-party client) |
| enable end session | `false` |

The public client ID is `cZwBKeVlLfMPdDbJNngYUzNGRUqZfxSO`. Its secret lives
in the mode-0600 local credential cache, the `OpenChat Ideaflow OIDC client`
1Password item, and GCP Secret Manager secret `openchat-oidc-client-secret`;
the ID is also mirrored in `openchat-oidc-client-id`. Never copy either value
into source.

Do not enable provider-initiated global logout for this phase: signing out of
OpenChat must remain local and must not kick someone out of Thoughtstream or
another important Ideaflow session.

The current stable Ideaflow ID provider intentionally restricts external access
token audiences to World Issue Tracker. OpenChat requests only OIDC identity
scopes, verifies the ID token, and discards provider tokens after the exchange;
it does not add an OpenChat resource audience or require a Better Auth upgrade.

## OpenChat configuration

Store the confidential client values in the production secret system, not in
source or build arguments:

```text
IDEAFLOW_ID_ENABLED=false
IDEAFLOW_ID_ISSUER=https://id.ideaflow.app/api/auth
IDEAFLOW_ID_CLIENT_ID=<registered client id>
IDEAFLOW_ID_CLIENT_SECRET=<registered client secret>
IDEAFLOW_ID_REDIRECT_URI=https://chat.globalbr.ai/auth/ideaflow/callback

# Cohort gate — see "Cohort gate" above. Both fail closed.
IDEAFLOW_ID_COHORT_ALLOWLIST=
IDEAFLOW_ID_ALLOW_NEW_USER_CREATION=false
```

`IDEAFLOW_ID_ENABLED` is a server-side kill switch. The integration remains
unavailable even when credentials exist until it is exactly `true`. RN-web
reads the public capability endpoint and renders the button only when the
server says the path is enabled, so disabling it does not require a new client
build. `IDEAFLOW_ID_COHORT_ALLOWLIST` and `IDEAFLOW_ID_ALLOW_NEW_USER_CREATION`
sit underneath the kill switch and independently fail closed (see above).

## Protocol flow

### Unauthenticated sign-in (`GET /ideaflow/url` + `POST /ideaflow/exchange`)

1. RN-web generates state, nonce, and a PKCE verifier/challenge and keeps the
   verifier in same-tab session storage.
2. `GET /api/auth/ideaflow/url` obtains the provider discovery document and
   returns an authorization URL containing the fixed registered callback.
3. Ideaflow ID redirects to `/auth/ideaflow/callback`; OpenChat forwards only
   the OAuth result to `/app/`.
4. RN-web verifies state and calls `POST /api/auth/ideaflow/exchange` with the
   one-time code, nonce, and verifier.
5. The server exchanges the code with `client_secret_basic`, verifies the ID
   token against discovered JWKS plus exact issuer, audience, expiry, and nonce,
   then resolves sign-in under the rules above (`resolveIdeaflowSignIn`).
6. The client stores the returned ordinary OpenChat JWT using the existing
   session path.

### Explicit, authenticated linking (`GET /ideaflow/link/url` + `POST /ideaflow/link/exchange`)

Same PKCE/state/nonce machinery, reused from an authenticated context (RN-web
Settings screen):

1. Settings calls `GET /api/auth/ideaflow/link/status` (bearer token) to show
   current link state.
2. On "Link Ideaflow ID", RN-web generates state/nonce/PKCE exactly as above
   and calls `GET /api/auth/ideaflow/link/url` (bearer token). The server
   requires the existing session and global kill switch, reserves the state
   once against that exact user/session/nonce/challenge, then starts the
   provider flow. It does not trust the legacy session email for cohort
   membership. Reusing the same state never overwrites the original record.
3. Same provider redirect and `/auth/ideaflow/callback` forward, distinguished
   from the sign-in flow by a `provider=ideaflow-link` marker RN-web adds to
   its stored client state (the server-side callback route is shared and
   provider-agnostic).
4. RN-web calls `POST /api/auth/ideaflow/link/exchange` (bearer token) with the
   code, state, nonce, and verifier. The server atomically consumes the pending
   transaction and verifies the same user/session/nonce/PKCE challenge before
   exchanging the provider code. It then verifies the ID token, checks the
   cohort against that token's verified email, and calls
   `bindIdeaflowIdentityToUser`, addressed by `req.user.userId`.
5. The existing OpenChat session is untouched — linking does not mint a new
   JWT or change what the client is signed in as.

The first rollout slice is web-only for both flows. Native iOS should later
use a separately registered public/native client with PKCE and no embedded
client secret.

The pending-link registry is process-local and intentionally fails closed on a
restart. Production currently uses one OpenChat API process. Move the registry
to shared storage before adding replicas; existing sessions and durable links
are unaffected, and an interrupted link only needs to be restarted.

## Safe rollout

1. Land and deploy the disabled code (`IDEAFLOW_ID_ENABLED=false`,
   `IDEAFLOW_ID_COHORT_ALLOWLIST` unset).
2. Register the confidential web client without changing any existing client,
   credential, session, or cookie.
3. Add OpenChat secrets, deploy the web/server release with the server kill
   switch still off, and confirm the capability endpoint reports disabled.
4. Enable the server flag and set `IDEAFLOW_ID_COHORT_ALLOWLIST` to one or a
   few test account emails. Guardedly pre-link high-confidence accounts from
   both authoritative databases; use explicit Settings linking for every
   ambiguous or unmatched account. RN-web reads the server capability at
   runtime, so this enable step does not require a second client build.
5. Grow `IDEAFLOW_ID_COHORT_ALLOWLIST` incrementally. Only set it to `*` (full
   rollout) once explicit linking and unauthenticated sign-in have both been
   verified in the cohort. Only set `IDEAFLOW_ID_ALLOW_NEW_USER_CREATION=true`
   once brand-new signups via Ideaflow ID are an intended product surface, not
   just a migration path for existing accounts.
6. Keep every legacy login path for at least the migration window. Monitor 409
   `link_required` responses — they mean a real person hit the login screen
   before linking; point them at Settings → Link Ideaflow ID. Never merge two
   user IDs automatically.
7. Add native clients separately. Removing old providers or moving password
   credentials is a later explicit project, not part of this rollout.

On 2026-09-18, both allowlisted pilot accounts were pre-linked with the guarded
administrative tool. The dry run reported two ready mappings, the apply linked
both in one transaction, and a repeat dry run reported both as already linked.
The shared Noos/OpenChat graph then contained two distinct identity keys. No
credentials, application-local IDs, sessions, or legacy login methods changed.

## Production execution record (2026-09-17)

The reviewed web rollout is deployed from commit `6fa2850` and remains
reviewable in [OpenChat PR 54](https://github.com/IdeaFlowCo/OpenChat/pull/54).
The release was first deployed with `IDEAFLOW_ID_ENABLED=false`; production
health, the disabled capability response, and the existing Google and Noos
redirects all passed before the pilot was enabled.

The deployed `bindIdeaflowIdentityToUser` helper was then exercised against
production Neo4j using four tagged disposable `User` nodes. Proof run
`openchat-oidc-proof-9229e0b1-1fee-42c9-aeaa-f6076e00fb6a` verified:

- concurrent different subjects targeting one user produced one link and one
  conflict;
- concurrent different users targeting one subject produced one link and one
  conflict;
- repeating the winning bind was idempotent; and
- an incompatible partial mapping was rejected.

All four proof nodes were deleted and a follow-up query returned zero tagged
fixtures.

The browser flow was verified separately with the provider's public demo
account and one uniquely tagged disposable OpenChat user. The production UI
completed Settings → Link Ideaflow ID, retained the existing OpenChat session,
signed out locally, and then signed back in through Ideaflow ID to the exact
same OpenChat user ID. The temporary demo cohort entry, disposable user,
issuer/subject mapping, browser state, and local/remote credential files were
removed afterward; follow-up queries returned zero tagged users and zero demo
identity mappings.

The active pilot configuration is intentionally narrow:

```text
IDEAFLOW_ID_ENABLED=true
IDEAFLOW_ID_COHORT_ALLOWLIST=jacob@ideaflow.io,tmad4000@gmail.com
IDEAFLOW_ID_ALLOW_NEW_USER_CREATION=false
```

RN-web presents Ideaflow as the primary sign-in method while the pilot is
enabled. Existing Google and password methods remain available under an
accessible disclosure and expand automatically after any provider error. A
`link_required` response displays an inline recovery explanation, then routes
the user to Settings after they authenticate with an existing OpenChat method.
This navigation does not create a mapping: this recovery flow still requires
the authenticated, one-use Settings linking flow and never links by email.

This evidence covers RN-web at `/app`. The current implementation deliberately
does not render or run Ideaflow ID login on native iOS or Android. Native
support remains a separate task requiring public clients, native redirect
handling, PKCE, and no embedded client secret (`OpenChat-mt6`). Publishing the
current shared client to TestFlight does not imply native Ideaflow support.

Upstream Google login at the identity provider also remains a distinct,
unverified path because its real-account password challenge was not used for
this proof. Email/password continuity and the OpenChat OIDC integration were
verified independently; existing OpenChat Google, Apple, password, Noos, and
already-issued application sessions remain available.

## Rollback

Set `IDEAFLOW_ID_ENABLED=false` and redeploy OpenChat. Existing OpenChat JWTs,
including ones originally minted after an Ideaflow ID sign-in, remain valid.
Do not delete the Ideaflow ID client or clear the stored issuer/sub mappings;
both are harmless while the path is disabled and preserve a safe re-enable.
