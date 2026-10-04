# OpenChat → IdeaFlow ID migration

This app-specific rollout implements the global identity decision recorded in
the private [Global Identity Architecture ADR](https://wikihub.globalbr.ai/@jacobcole/jacobcole/projects/global-identity-architecture)
and its [Noos decision node](https://globalbr.ai/node/wv1Iq1CpnuMkplv2sYCI9):
IdeaFlow ID owns authentication, while each application keeps its own stable
user IDs, authorization, data, and sessions.

## Goal

Add centralized Ideaflow sign-in without turning an identity-provider rollout
into an account or session migration. OpenChat continues to own its user IDs,
authorization, conversations, and application sessions. IdeaFlow ID supplies a
standards-based external identity.

Existing email/password, Google, Apple, Noos JWT, and OpenChat JWT paths stay in
place during the rollout. Enabling this integration does not invalidate an
already-issued token and does not sign a user out of OpenChat, Thoughtstream, or
any other Ideaflow application.

## Identity and linking contract

The durable external key is the exact pair:

```text
issuer = https://id.ideaflow.app/api/auth
sub    = <IdeaFlow ID subject>
```

OpenChat stores that pair as `User.ideaflowIssuer` and `User.ideaflowSub` and
enforces a unique derived `User.ideaflowIdentityKey` before looking at email.
On first sign-in only, an IdeaFlow ID email
may link to a legacy OpenChat user when all of the following are true:

1. the ID token says `email_verified: true`;
2. exactly one case-insensitive OpenChat email match exists; and
3. that user has no conflicting IdeaFlow ID mapping.

Ambiguous or conflicting matches return HTTP 409 for manual support review.
Email is not the durable cross-application identity key and an existing mapping
is never silently replaced.

After linking, OpenChat mints its ordinary seven-day application JWT. It does
not use the IdeaFlow ID access token as an OpenChat API token, and it does not
share provider cookies across domains.

## Provider-side registration (human-gated)

IdeaFlow ID production disables dynamic client registration. An IdeaFlow ID
administrator must create this confidential first-party client using the
provider's server-only registration procedure:

| Field | Value |
| --- | --- |
| client name | `OpenChat Web` |
| client URI | `https://chat.ideaflow.app` |
| redirect URIs | Both OpenChat hosts; see the [domain rollout](./chat-domain-rollout.md) for the exact registrations |
| post-logout redirect URIs | none during additive migration |
| scopes | `openid profile email` |
| token endpoint auth | `client_secret_basic` |
| grant types | `authorization_code` |
| response types | `code` |
| application type | `web` |
| require PKCE | `true` |
| skip consent | `true` (first-party client) |
| enable end session | `false` |

Do not enable provider-initiated global logout for this phase: signing out of
OpenChat must remain local and must not kick someone out of Thoughtstream or
another important Ideaflow session.

The current stable IdeaFlow ID provider intentionally restricts external access
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
IDEAFLOW_ID_REDIRECT_URI=<registered callback for the primary OpenChat host>
```

`IDEAFLOW_ID_ENABLED` is a server-side kill switch. The integration remains
unavailable even when credentials exist until it is exactly `true`. RN-web
reads the public capability endpoint and renders the button only when the
server says the path is enabled, so disabling it does not require a new client
build.

## Web sign-in surface: "you sign in with Ideaflow"

Ideaflow ID is the sign-in for every Ideaflow app (OpenChat-3ag.12; single
button since 2026-10-03, code-xbh.3). On RN-web, while
`GET /api/auth/ideaflow/config` reports `enabled: true`:

- the login screen shows exactly one sign-in control, **Sign in with
  Ideaflow**, with the hint "New here? You can create an account on the next
  screen." There is no Google button, email/password form, create-account
  link, "Other sign-in options" or "Use another Ideaflow account". Google,
  email/password, sign-up and password reset all happen on id.ideaflow.app.
  Nothing is rendered until the capability check answers (8-second ceiling),
  so Google never flashes first;
- existing OpenChat users are not stranded: the exchange links an existing
  user by issuer+subject, else by a single strictly verified email match
  (`linkIdeaflowIdentity`, contract above), else creates a new user. Noos
  password and Google users therefore land in their existing account when
  their Ideaflow ID uses the same verified email;
- ordinary sign-in sends no `prompt`, so an existing Ideaflow ID session
  completes silently. After an explicit OpenChat sign-out (not a session
  expiry) the next sign-in sends `prompt=select_account` once, so the provider
  asks which account to use (`markIdeaflowAccountChoice` in `ChatContext`);
- **Switch account** in the signed-in account menu (desktop avatar menu and
  Profile, above **Sign out**) also requests `prompt=select_account`. It first
  prepares the authorization URL, then performs the ordinary app-local
  OpenChat sign-out, then redirects.

`/api/auth/ideaflow/url` accepts no `prompt`, exactly `select_account`, or
exactly `none` (automatic sign-in, below); any other value is rejected with
HTTP 400. Ideaflow start and callback failures
(including a cancelled account choice) are shown inline on the login page with
fixed, readable copy (provider error text is never echoed), because RN-web's
`Alert.alert` is a no-op. If the server disables Ideaflow ID or the
capability check fails, web falls back to the legacy methods; that kill-switch
fallback is the only way the legacy web methods appear. Native iOS and
Android follow the same capability response; see
[Native sign-in](#native-sign-in-ios-and-android-code-xbh14). Covered
by `apps/server/test/ideaflowOnlyLogin.mobile.test.ts`,
`apps/server/test/signOut.mobile.test.ts` and
`apps/mobile/src/services/ideaflowSignIn.test.ts`.

## Automatic cross-app sign-in (web, code-xbh.21.1)

Someone already signed in to Ideaflow ID (from any Ideaflow app) who opens the
OpenChat web app signed out is signed in without a click:

- after the app's own session check comes back signed out, the login screen
  shows a neutral spinner (never the sign-in page) and, once per browser
  session, does ONE `location.replace` to the normal Ideaflow start with
  `prompt=none` (`useIdeaflowAutoSignIn`, `services/ideaflowAutoSignIn.ts`);
- the same-tab pending record (state/nonce/PKCE in `sessionStorage`) also keeps
  `silent: true` and the original same-origin path + query + hash. A code is
  redeemed only for the stored state, then that URL is restored. Any provider
  error (`login_required`, ...) or app-level failure of a silent attempt
  (duplicate-email 409, linking, anything) returns to the original URL signed
  out with no error. The explicit button keeps its full flow and errors;
- guards: a first-party session cookie `ideaflow_auto_signin` (no expiry,
  Secure, SameSite=Lax, set before leaving; a callback load also sets it); an
  explicit OpenChat sign-out (`openchat_ideaflow_signed_out` in localStorage,
  cleared when a session is established, plus the select-account marker);
  callback loads; native iOS/Android; embedded webviews, in-app browsers and the
  desktop Tauri shell (UA tokens, bare WKWebView UA, `__TAURI_INTERNALS__`,
  `ReactNativeWebView`, Capacitor, Electron); crawlers/unfurlers (shared
  Ideaflow UA list); prerender; frames; blocked cookies;
- kill switch: `IDEAFLOW_AUTO_SIGNIN=false` in `/opt/openchat/.env`, then
  recreate the container (`docker compose up -d --no-build openchat`). The
  server reports `autoSignIn` in `/api/auth/ideaflow/config`; the client acts
  only on an explicit `true`. Default on.

Covered by `apps/server/test/ideaflowAutoSignIn.mobile.test.ts` and
`apps/mobile/src/services/ideaflowAutoSignIn.test.ts`.

## Password recovery capability

The [signed-out recovery help](../apps/mobile/README.md#password-recovery-entry)
is independent of the login rollout. `GET /api/auth/ideaflow/config` returns
`enabled` for login and includes `passwordResetUrl` only when login is enabled
and fully configured, `IDEAFLOW_PASSWORD_RESET_ENABLED=true`, and
`IDEAFLOW_PASSWORD_RESET_URL` exactly matches the configured issuer origin's
`/forgot-password` URL. Recovery defaults off; login opt-in alone does not
enable it. Issuers with userinfo, a query or a fragment are rejected for recovery;
the destination cannot include userinfo, a query, a fragment or a trailing slash.
The capability response uses `Cache-Control: no-store` and exposes no credentials.

Keep recovery disabled until the provider owner verifies that exact route, mail
delivery, password-account recovery, identity preservation and Google/Apple-only
behavior. A working isolated provider fixture does not establish production
readiness. Source merge neither activates recovery nor authorizes production auth
deployment, mail delivery or cohort expansion. The recovery help does not migrate
or link accounts; the sign-in linking contract above remains separate.

Client availability is described in the recovery help documentation linked above;
enabling recovery does not enable native Ideaflow ID login. The contract is
covered by `apps/server/test/passwordRecovery.config.test.ts` and
`apps/server/test/ideaflowAuthRoutes.test.ts`.

## Protocol flow

1. RN-web generates state, nonce, and a PKCE verifier/challenge and keeps the
   verifier in same-tab session storage.
2. `GET /api/auth/ideaflow/url` obtains the provider discovery document and
   returns an authorization URL containing the registered callback for the
   requesting OpenChat host. The token exchange uses that same callback.
3. IdeaFlow ID redirects to `/auth/ideaflow/callback`; OpenChat forwards only
   the OAuth result to `/app/`.
4. RN-web verifies state and calls `POST /api/auth/ideaflow/exchange` with the
   one-time code, nonce, and verifier.
5. The server exchanges the code with `client_secret_basic`, verifies the ID
   token against discovered JWKS plus exact issuer, audience, expiry, and nonce,
   then links the OpenChat user under the rules above.
6. The client stores the returned ordinary OpenChat JWT using the existing
   session path.

## Native sign-in (iOS and Android, code-xbh.14)

Native apps ask the same `GET /api/auth/ideaflow/config`. When it reports
`enabled`, the login screen shows **Sign in with Ideaflow** and the "New here?"
hint; Google, email/password and "Create one" are gone. The legacy native
methods (and the "Uses your Noos credentials" footer) return only when the
server disables Ideaflow ID or the check fails, so the server flag is the kill
switch for native too, with no app update.

iOS keeps the native **Sign in with Apple** button under the Ideaflow button
("Signed up with Apple? You can keep using it.") because Apple-only accounts,
often private-relay emails, cannot reach their OpenChat account through
Ideaflow ID until it offers Sign in with Apple (code-xbh.13). Removing it is
one constant, `KEEP_NATIVE_APPLE_SIGN_IN` in
`apps/mobile/src/services/ideaflowSignIn.ts`, shipped as an EAS update for the
same runtime once id.ideaflow.app offers Apple.

Flow (`apps/mobile/src/services/ideaflowNativeSignIn.native.ts`):

1. The app generates state, nonce and a PKCE verifier/challenge with
   `expo-crypto`. The state starts with `native-`.
2. `GET /api/auth/ideaflow/url` returns the authorization URL for the
   confidential web client and the host's registered https callback, exactly as
   on web. Ordinary sign-in sends no prompt (silent SSO); the first sign-in after
   an explicit sign-out sends `prompt=select_account` (marker in AsyncStorage).
3. `expo-web-browser`'s `openAuthSessionAsync` opens it in the system auth
   session (ASWebAuthenticationSession on iOS, Custom Tabs on Android) with
   `preferEphemeralSession: false`, so the system browser's Ideaflow ID and
   Google sessions are reused. It is never an embedded web view, which Google
   blocks.
4. `/auth/ideaflow/callback` sees the `native-` state and redirects to
   `openchat://auth/ideaflow/callback?provider=ideaflow&code=…&state=…`
   instead of `/app/`. The auth session hands that URL back to the app.
5. The app accepts only its own state, then calls
   `POST /api/auth/ideaflow/exchange` with the code, nonce and verifier. The
   server redeems the code with its client secret plus the PKCE verifier, which
   never left the device, verifies the ID token, links the account under the
   rules above, and returns an ordinary OpenChat JWT stored in SecureStore.

A bounced code is useless without the verifier, and the app rejects any state
it did not generate. Native therefore needs no separately registered public
client.

**Switch account** on Profile (and the tablet account menu) opens the
provider's chooser first while still signed in. Only after an account is picked
does the app sign out locally and redeem the new code, so cancelling changes
nothing.

App Store guideline 4.8: OpenChat's only sign-in is the company's own account
system, Ideaflow ID, plus Sign in with Apple while it remains, so the
third-party-login requirement does not apply. Say so in the review notes.

## Safe rollout

1. Land and deploy the disabled code (`IDEAFLOW_ID_ENABLED=false`).
2. Register the confidential web client without changing any existing client,
   credential, session, or cookie.
3. Add OpenChat secrets and smoke-test the server capability endpoint while
   `IDEAFLOW_ID_ENABLED=false`.
4. Enable the server flag in an isolated test environment and verify
   legacy-account linkage before any separately authorized production rollout.
   The flag applies to that server, not to an individual account; the web client
   follows the capability response without a separate build flag.
5. Keep every legacy login path for at least the migration window. Monitor 409
   collisions and resolve them manually; never merge two user IDs automatically.
6. Native follows the same server flag (code-xbh.14). Removing old providers or moving password
   credentials is a later explicit project, not part of this rollout.

## Rollback

Set `IDEAFLOW_ID_ENABLED=false` and redeploy OpenChat. Existing OpenChat JWTs,
including ones originally minted after an IdeaFlow ID sign-in, remain valid.
Do not delete the IdeaFlow ID client or clear the stored issuer/sub mappings;
both are harmless while the path is disabled and preserve a safe re-enable.
