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
IDEAFLOW_ID_REDIRECT_URI=https://chat.globalbr.ai/auth/ideaflow/callback
```

`IDEAFLOW_ID_ENABLED` is a server-side kill switch. The integration remains
unavailable even when credentials exist until it is exactly `true`. RN-web
reads the public capability endpoint and renders the button only when the
server says the path is enabled, so disabling it does not require a new client
build.

## Protocol flow

1. RN-web generates state, nonce, and a PKCE verifier/challenge and keeps the
   verifier in same-tab session storage.
2. `GET /api/auth/ideaflow/url` obtains the provider discovery document and
   returns an authorization URL containing the fixed registered callback.
3. IdeaFlow ID redirects to `/auth/ideaflow/callback`; OpenChat forwards only
   the OAuth result to `/app/`.
4. RN-web verifies state and calls `POST /api/auth/ideaflow/exchange` with the
   one-time code, nonce, and verifier.
5. The server exchanges the code with `client_secret_basic`, verifies the ID
   token against discovered JWKS plus exact issuer, audience, expiry, and nonce,
   then links the OpenChat user under the rules above.
6. The client stores the returned ordinary OpenChat JWT using the existing
   session path.

The first rollout slice is web-only. Native iOS should later use a separately
registered public/native client with PKCE and no embedded client secret.

## Safe rollout

1. Land and deploy the disabled code (`IDEAFLOW_ID_ENABLED=false`).
2. Register the confidential web client without changing any existing client,
   credential, session, or cookie.
3. Add OpenChat secrets and smoke-test the server capability endpoint while the
   UI build flag remains off.
4. Enable the server flag for a test account, verify legacy-account linkage,
   then ship a web build with the client flag on.
5. Keep every legacy login path for at least the migration window. Monitor 409
   collisions and resolve them manually; never merge two user IDs automatically.
6. Add native clients separately. Removing old providers or moving password
   credentials is a later explicit project, not part of this rollout.

## Rollback

Set `IDEAFLOW_ID_ENABLED=false` and redeploy OpenChat. Existing OpenChat JWTs,
including ones originally minted after an IdeaFlow ID sign-in, remain valid.
Do not delete the IdeaFlow ID client or clear the stored issuer/sub mappings;
both are harmless while the path is disabled and preserve a safe re-enable.
