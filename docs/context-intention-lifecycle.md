# Context intention lifecycle

Context Ask and Offer posts remain shared conversation text. They become tracked
intentions only when their author explicitly chooses **Track** or **Link existing**
from a direct human session. Ordinary posts, agent writes and hosted drafts never
create intentions automatically.

`AgentIntent.id` remains the canonical identity. A tracked Context post has a
`REPRESENTS_INTENT` relationship recording its original revision, text digest and
tracking request ID. Existing Stories retain their `ACTIVATES` relationship to the
same intention. The owner inventory groups these projections by intention ID.
Linking a private or already active intention never copies its private goal,
matching terms, details or Story text into Context, and never changes its existing
approved matching audience. The shared intention metadata contains only its ID,
lifecycle state, revision and source-change flag.

A new Context-only intention is paused, conversation restricted, and permanently
excluded from the network-matching candidate and decision paths by `contextOnly`.
Changing its legacy search status to active cannot opt it into matching. It does
not create a Story, an agent scan, a Message or a notification.

## Owner controls

In a conversation’s **Context** lane, your Ask/Offer post offers **Track ask** or
**Track offer**, and **Link existing intention**. Linking shows your private
inventory and requires **Confirm intention link**. In **Asks**, each intention
groups its Context sources and Stories, with source links and eligible Story/search
pause and resume controls. **Mark fulfilled**, **Withdraw intention**, and
**Reopen intention** first show the affected projections; apply the reviewed
change with **Confirm intention change**.

- `GET /api/chat/context-intentions` returns grouped owner intentions and their
  currently accessible Context projections plus owned Stories. Private inventory
  is never returned to API keys, connector operations or embedded sessions.
- `GET /api/chat/context-intentions/:id` returns one currently owned intention,
  including its current revision and eligible linked projections. Lifecycle
  confirmation uses this direct lookup, so intentions older than the 200-item
  inventory window remain reviewable. Foreign or missing IDs return 404; agent,
  connector and embedded credentials cannot read this owner-private detail.
- `POST /api/chat/conversations/:conversationId/context/:postId/intention` accepts
  `{sourceRevision,clientRequestId,intentId?}`. Omitting `intentId` tracks a new
  canonical intention; supplying it links the author's existing intention.
  Concurrent/repeated tracking reuses one ID. A post cannot be reassigned silently.
- `PATCH /api/chat/context-intentions/:intentId` accepts
  `{expectedRevision,lifecycleState:'open'|'fulfilled'|'withdrawn'}`.

Lifecycle state is separate from agent-search status. Marking fulfilled or
withdrawn closes linked Context projections, withdraws linked Stories, stops new
matching and closes proposed matches. Existing connected-match history remains.
The UI must explain that all linked projections are affected before this action.
Reopening restores Context's open status only: matching stays paused and Stories
stay withdrawn. Sharing a Story again still requires its explicit publication
flow. Reopening requires live access to every surviving linked Context
conversation and respects the existing 50-open-asks/offers quota per conversation.

Source edits preserve the canonical ID and mark the link's provenance changed;
canonical private terms are not automatically rewritten. Deleting a Context post
removes that projection from the inventory, without closing the intention's other
Context or Story projections. A lost conversation membership hides that Context
source from owner inventory reads. Personal Stream remains separate.

Status changes increment each linked Context revision. Pending hosted/key requests
and webhook wakes bound to an earlier revision therefore remain invalid even if
the owner quickly closes and reopens the intention. Closing and tracking use the
same owner/conversation locks as Context mutations. Legacy explicit intention
withdrawal also closes its linked projections.

## Validation

`contextIntentions.integration.test.ts` uses an isolated real Neo4j and synthetic
accounts. It tests concurrent idempotent identity creation, existing Story linking,
no private-field leakage, lifecycle and quiet behavior, source edits/deletion,
live membership checks, stale revisions, network exclusion even after forced
legacy activation, and human-only authentication. Model scoring is mocked and
must not run for Context-only intentions; no production user or external send is
used.
