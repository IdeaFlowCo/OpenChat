# Google account binding

Source-only security repair: **openchat-asv**. Recovery and rollout follow-up:
**openchat-ec0**. Implementation: `apps/server/src/services/googleIdentity.ts`;
both Google exchanges in `apps/server/src/routes/auth.ts` use it. The database
initializer and `authGoogle.integration.test.ts` define its schema and tests.

## Diagnosis and evidence

Expected behavior: a verified Google subject authenticates its previously bound
OpenChat user ID. A matching email cannot authorize access to another account or
replace a different stored subject. Existing User nodes, IDs, profiles, and
relationships must survive both successful sign-ins and denied collisions.

At base `25f12f690d7df16506671ef37849d0fc7b75bc08`, both routes instead ran
`MERGE (u:User {email: $email})`, retained `coalesce(u.googleSub, $sub)`, and
signed a JWT for the matched user without comparing subjects. The auth and
database files are unchanged in the subsequent base
`d48150635c92dfab8b4209768108fce38e93ca01`.

| Diagnostic element | Evidence / limit |
| --- | --- |
| Trigger | Google verification succeeds with the existing account's email and a different `sub`. |
| Visible outcome | Both baseline routes return HTTP 200 and a correctly server-signed JWT containing the seeded existing user's ID. The different stored subject stays in place. |
| Masking conditions | Ordinary same-subject/same-email sign-in succeeds, so ordinary login smoke tests miss it. Invalid signatures, wrong audiences, expired tokens, failed code exchange, or a different email do not exercise this collision. |
| Proven paths | Seeded real Neo4j, mocked valid `verifyIdToken` for native, mocked successful token and userinfo responses for web. Both verified and unverified email claims grant the wrong account on the baseline. |
| Divergent paths | The native route verifies signature, issuer, expiry, and configured audience via Google's library. The web route uses its confidential client to exchange the code, then obtains userinfo using that access token. The tests do not bypass these paths with a supplied request-body email. |
| Smallest counterfactual | Keep the seed and email fixed; change only Google's subject. Matching-subject controls pass; different-subject cases expose the seeded account ID in the baseline JWT and return 409 after the repair. |
| Other baseline defect | Same subject with a changed email creates a second User and new OpenChat ID. The repair returns the original ID. Historical duplicates require disposition, not automatic merging. |
| Falsification | Failure to return the seeded account JWT under the stated valid-provider preconditions would falsify the route-level finding. Evidence that a particular account cannot receive a different-subject/same-email Google assertion rules out that account's prerequisite; it does not repair the application's binding rule. |

The initial baseline run had **8 expected failures and 2 passing controls**;
the identical initial cases passed after the repair. The expanded tests exercise
both routes, denied linking, invalid proof, duplicate legacy data, and real
concurrent transactions. All credentials and users in those tests are fixtures.
No live Google token, production account, production schema, or installed
iPhone flow was tested, and no actual compromise is established.

Review of the initial repair at `c64d25c1ee03fcf33b8eaad896b759fec0d5796a`
identified a second ambiguity: a unique Google subject could select a User whose
`id` is shared by another User. JWTs and downstream authorization use that ID,
so subject uniqueness alone is insufficient. Seeding just one additional User
with the same ID and a different subject reproduced token issuance in both
exchanges, for ordinary sign-in and an explicit link to the already-bound
account (**4 failing regressions, 2 passing unique-ID link controls**). Unbound
explicit links already rejected duplicate IDs; the mapped-subject branch
bypassed that check. Absence of duplicate IDs masks this defect, and refusal to
issue a token in this exact seeded case would falsify the finding. We have not
inspected production for duplicate IDs or demonstrated unauthorized access to
any real account through this condition.

Every resolution path now requires exactly one User with the selected account
ID, matching the selected node, inside the same transaction before returning.
Ambiguity returns 409 without a JWT and rolls back profile changes. Both-route
tests assert that both seeded Users remain unchanged, with or without an ambient
account bearer. Explicit linking was subsequently disabled as described below;
unique subject-bound accounts continue through ordinary Google sign-in.

History: web email linking began in `d55dbab` (2026-05-30), native email linking
in `8707dbb` (2026-05-31); the monorepo migration retained both. This is
independent of the native callback/feedback change in
https://github.com/IdeaFlowCo/OpenChat/pull/106.

## Realistic exploitability

A valid ID token accepted for an OpenChat Google client with the same email and
a different subject was sufficient at the application boundary. For the code
route, a valid code that produces the equivalent userinfo is sufficient. Knowing
an email, forging a JWT, or obtaining a token for an unrelated audience is not.
We have not demonstrated obtaining the necessary Google assertion for any real
OpenChat user.

Potentially affected accounts include Google-linked users with a conflicting
subject and legacy users with no Google subject. The prerequisite matters most
for third-party addresses and reassigned organizational addresses. Google's
guidance says a third-party email may no longer be owned by the Google user even
when `email_verified` remains true; Gmail and verified Workspace identities have
different email-authority properties. This does not show that arbitrary Gmail
addresses can acquire another subject. See [Google's verification and account
linking guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

Checking only `email_verified` would therefore leave the verified-email case
unfixed. The repair uses the subject for authentication and treats email as a
contact attribute. New accounts require a verified, valid-format
email, but an existing subject binding does not depend on current email claims.

## Account preservation and recovery

| Case | Result |
| --- | --- |
| Exactly one User with the verified subject and exactly one User with its account ID | Authenticate that existing ID, even if Google email changes, is absent/unverified, or now matches another account. Preserve `User.email`; store current provider claims separately in `googleEmail` / `googleEmailVerified`. |
| Unknown subject, existing email (case-insensitive) | 409, no JWT, no new User, no implicit linking. |
| Unknown subject, previously unused verified email | Create a new User, as normal signup. |
| `link: true`, with any bearer or Google proof | 409 before provider verification or database access. Linking is unavailable, including for already-bound subjects; those subjects use ordinary sign-in. Malformed link intent returns 400. |
| Unknown subject with an email belonging to a differently bound account, or duplicate legacy subject/account ID | 409. Do not overwrite a subject, choose a duplicate, migrate IDs, or create a replacement account. |

The resolver accepts only a Google identity, never an account ID from a bearer or
request body. Existing account sessions do not authorize linking. Requests to
link are explicitly rejected rather than being reinterpreted as signup. The
canonical clients send only the code/redirect URI or ID token; this removes a
newly proposed capability, not an existing client linking feature.

The initial repair proposed bearer-authorized linking. Review found that an
existing non-Google auth path can issue an unrelated account bearer under its
own email-fallback conditions. The local Google fixtures independently show
that a valid account-session signature sufficed to bind an unset subject on the
initial repair: four denied-link regressions return 200 against `d1af987`, for
bound and unbound accounts on both routes. Those JWTs contain no fresh ownership or authentication-source
assurance, so a signed or recently issued bearer cannot safely authorize a new
Google binding. The final repair removes that capability entirely. Apple and
other providers are unchanged and require separate security disposition;
this PR does not claim to repair them, revoke old JWTs, or correct historical
bindings.

An unbound legacy account with a colliding email now remains inaccessible via
Google until a **separately reviewed recovery/linking flow** independently
proves ownership. This applies even to a legitimate holder of an existing
account session. The existing node, ID, contact email, profile, and relationships
remain unchanged; the repair never creates a replacement for that collision.
Duplicate/disputed subjects or IDs likewise require a recovery decision.
Before production cutover, the recovery/product owner must choose and validate
that proof. **No automatic recovery, reassignment, deletion, or account merge is
part of this repair.**

## Schema, races, and release limits

The repository's initializer has no global User-email, User-ID, or Google-subject
uniqueness constraint. Production shares the Noos database and may have extra
constraints created elsewhere; its actual schema and duplicate counts remain
uninspected. Adding uniqueness to legacy data could reject startup or require
destructive cleanup, so this repair does neither.

Instead, a unique `OpenChatGoogleAuthLock.key` constraint serializes the two
Google routes by normalized email and exact subject inside one `executeWrite`
transaction. A nonunique `User.googleSub` index supports the subject lookup.
Failed checks roll back; JWT issuance occurs only after commit.

Concurrent tests cover same subject with different emails, different subjects
registering the same unused email, and two subjects colliding with one unbound
legacy email without changing or duplicating its account. These guarantees
coordinate the repaired Google writers. Other
providers or an old server instance do not participate in these locks; they can
still race on shared emails or introduce duplicate IDs/subjects after the
transaction's checks. The ID check rejects observed ambiguity; it is not a
global uniqueness constraint or a repair for previously issued sessions.
Cross-provider email provisioning and previously issued sessions need their own
disposition. Do not claim this repairs all
identity providers or deploy a mixture of old and repaired Google writers.

Local validation used a task-private Neo4j **2026.06.0** server because Docker
pulls stalled. All Cypher uses constructs available in 5.26, but local results
alone do not establish version compatibility. The dedicated GitHub workflow
pins **Neo4j 5.26.0** and runs the real transaction/route tests on every PR.
The final suite has **69 cases**, including disabled linking, subject and ID
ambiguity, account preservation, email verification, and transaction races.

Before any separately authorized rollout, review recovery cases and the shared
schema/other writers, initialize the additive constraint/index, and arrange
deployment without old Google handlers remaining reachable. This PR authorizes
none of those production actions. The iPhone release remains gated on physical
tap/callback proof plus a security disposition; source merge is not release
approval.
