# Hosted Context delivery · 2026-10-07

OpenChat-3qyp. Implementation [PR146](https://github.com/IdeaFlowCo/OpenChat/pull/146),
merged source `a5d32cbd`, preserves PR144 conversation fixes and PR145 profile capture.
The display lane explicitly transferred shared-file and native release custody after
1.0.17 build130. No ChatContext or MessageList source was changed by this delivery.

## Delivered behavior

**Agent drafts** is reachable directly from Chats, including the collapsed desktop
sidebar. Hosted generation is off per account until the owner explicitly enables
it. Anthropic processes the requested shared post and only private text explicitly
provided for that request. It produces a private proposal with no tools or posting
authority. Publication requires separate owner review of exact reply, provenance,
destination and audience. Current and future authorized conversation members can
read the published Context reply. No chat messages, notifications or read-state
changes are produced.

Human session authentication is required for review; agent keys, connector
operations and embedded sessions cannot approve. Transactional publication checks
live membership, blocks, source revision, audience, opt-in generation and immutable
approval. Turning off, editing private input, expiry, access changes and account
deletion invalidate or remove private drafts. See [operator/API contract](../context-hosted-approval.md).

## Validation

- Server build and full suite:754 Vitest tests plus7 bridge tests passed.
- Focused mobile/API suite:16 passed for PR146;17 with the web accessibility
  follow-up PR147. Mobile TypeScript passed.
- Root lint, typecheck and build passed on an isolated M3 checkout after a clean
  locked dependency install. Two pre-existing legacy-client lint warnings remain.
- All five PR146 CI checks passed. [Mobile/Neo4j CI run](https://github.com/IdeaFlowCo/OpenChat/actions/runs/37585346071)
  includes all11 hosted database scenarios with a fake model, plus14 UI and2 API tests.
- Independent review corrected orphaned draft retention on source-author deletion,
  obsolete drafts, active-inbox ordering, stale metadata, and local typed private
  text remaining visible after access loss. Regression coverage accompanies fixes.
- Synthetic visual checks at390px and1440px, light/dark: no horizontal overflow,
 44px controls, explicit Anthropic notice, and Publish absent during editing/private
  input. The web screen-reader switch-state correction is in
  [PR147](https://github.com/IdeaFlowCo/OpenChat/pull/147); independent browser
  validation reproduced the old missing state and confirmed false/true states
  after keyboard activation with the fix.
- Deployed web/server1.0.18 at07:09:53UTC from `a5d32cbd`; health and `/app` return200.
  Availability flag is forwarded; user preferences were not changed by deployment.
- [23 production read-only checks](2026-10-07-hosted-context-readonly.json) passed:
  availability true, dedicated synthetic owner off before/after, empty private
  inbox, no-store responses, anonymous/key-format401, genuine embedded-session403.
  No users were enrolled, no generation requested, no API keys minted, no private
  content published and no messages sent. Synthetic login sessions were signed out.

A separate synthetic provider smoke invoked the deployed generation function once
with a fictional test prompt and no private input. Anthropic returned nonempty
text (268 characters); no request job, draft, Context post or message was created.
This verifies the live provider credential/model path beyond fake-model CI.

Synthetic visual receipts: [phone review](2026-10-07-hosted-context-phone.png),
[desktop dark review](2026-10-07-hosted-context-desktop.png). All depicted content
is fixture data, not real conversations.

## Native delivery

Native1.0.18 build131 was built on M3 from `a5d32cbd`, uploaded through
[EAS submission](https://expo.dev/accounts/ifexpo/projects/openchat-mobile/submissions/501f4ebe-af79-4f28-b4ac-abb10e0fcb4f),
and assigned to Friends and Family. App Store Connect confirms build
`0eb05d4d-d112-45c6-a1fe-793fa9c43b70` is VALID, unexpired, IN_BETA_TESTING internally
and WAITING_FOR_BETA_REVIEW externally. Builds127 and130 are still VALID and
unexpired. Apple review is an external distribution gate, not a request for build
permission. PR147 changes only the web switch attribute; native checked-state
behavior remains the same as this binary.

Broader design follow-ups remain separate: OpenChat-lsme reconciles Context with
Asks/Stories lifecycle; OpenChat-50wt covers external webhooks and unified conversation
reads. Shared connector actual-host installation/publication is tracked by
OpenChat-y650 and does not follow automatically from successful OAuth/API checks.
