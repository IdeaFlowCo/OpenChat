## Q1. Thoughts V1 Spec Review

Caveat: the requested `SPEC.md` path is missing, so this is based on the provided v1 shape plus the nearby BetterGPT memory mockups and Cortex reduction plan.

The single underlying item store is the right instinct. Separate first-class `Cards`, `Issues`, `Todos`, `Decisions`, etc. would be premature taxonomy drag. But I would not name the primitive `:Thought`; that makes a shared task, public note, extracted decision, and private journal entry all sound like the same private mental object. Use something like `StreamItem` / `MemoryItem`, with `kind` and tags as annotations. Then `Card` is just “addressable item”, and `Issue` is `kind=issue` plus optional status.

What is missing for v1 is not more item types. It is provenance and permission clarity:

- `sourceMessageId`, `sourceConversationId`, `sourceChannel`, and `captureMethod` should be first-class.
- `authorUserId` is not enough; include `createdBy` and `ownedBy` separately if agents can capture for humans later.
- Tags need normalization eventually, but v1 can store strings plus a canonical lowercased index.
- Edits/deletes need a minimal policy now, even if history comes later.
- `#todo` needs either no status at all or one tiny `state: open|done`; pretending todos have no lifecycle will become annoying immediately.

The tag-driven capture UX is good, but “message starting with `#idea` both sends and captures” should be explicit capture syntax, not a magical hashtag parser. Otherwise normal chat messages can create durable notes accidentally. I would support `#idea text` and `#todo text` only at message start, record the original message, and render a small “saved” affordance.

The visibility-set model is the shaky part. It is not isomorphic with BetterGPT workspace scopes. Workspace scope is a context/provenance/default-access model: personal, DM, group, public. A visibility set is an ACL. They overlap, but one does not replace the other.

If you encode scope only as `{+convId,+userId}`, you lose important semantics: group membership changes, public discoverability, workspace/tool access, and “created in a group but saved privately.” If you encode everything only as workspace scope, you lose ad hoc sharing and peer-to-peer grants.

Recommended v1 shape: each item has `homeScope: personal|dm|group|public` with `scopeId`, plus `visibility: private|scope|public` and optional explicit grants. For most v1 items, grants are empty. A group item shared to the group is `homeScope=group`, `visibility=scope`; a note captured from a group but private is `homeScope=group`, `visibility=private`. That distinction matters.

Over-built for v1: AI extraction, relations, rich issue workflow, arbitrary ACL sets as the primary model. Under-built: source links, simple item lifecycle, and scope/access invariants.

## Q2. Picortex / Linq / OpenChat Relationship

What runs today when someone `@picortex` in OpenChat:

1. `OpenChatChannel` connects to `chat.globalbr.ai` with the bot JWT, fetches `/api/chat/conversations`, emits `conversation:join`, listens for `message:new`, ignores self-sent messages, and converts the event into a generic `InboundMessage`.
2. `server.ts` passes that into the shared `TurnDispatcher`; it also registers `channelByName.openchat` so replies return through OpenChat instead of Linq.
3. `TurnDispatcher` writes the inbound to local SQLite, serializes turns per chat, applies attention gating, checks manifest/consent rules, builds recent transcript context from SQLite, calls the Anthropic/scripted executor, then sends via `OpenChatChannel.send()` using socket.io `message:send`.

So OpenChat is using real picortex machinery: local SQLite chat history/events, attention mode, manifest/privacy consent, turn builder, Anthropic executor, per-chat turn serialization, and channel routing. OpenChat itself is not invoking the LLM; it is just delivering socket events to an external bot process.

Linq-coupled pieces:

- `LinqChannel` webhook validation, parsing, outbound sends, reactions, typing.
- `ReactionHandler`, which is Linq-only.
- `ConsentBroker` is constructed with the Linq channel, so consent DMs go to Jacob through Linq even for OpenChat-originated turns.
- Defaults and identifiers assume phone handles.

Linq-independent pieces:

- `OpenChatChannel`.
- The `Channel` abstraction in principle.
- Dispatcher, attention gate, SQLite persistence, turn builder, executor, and manifest logic, though they still carry texting-agent assumptions.

A minimal OpenChat-native agent should not depend on picortex. Add a bot worker inside OpenChat or as a tiny adjacent service: on message creation, check whether a bot participant should respond, load recent messages from Neo4j, call the model/tools, create a bot `Message`, update conversation preview, and emit `message:new`. Use OpenChat’s existing auth, conversation membership, and graph store. Add job/queue state only when tools become long-running.

Recommendation: write fresh, while borrowing only the good small ideas: websocket-only transport, per-conversation gating, self-message dedupe, and maybe the `Channel` boundary if you truly want multi-channel later. Keeping picortex as-is means importing Linq’s product assumptions into OpenChat. Extracting the OpenChat subset is viable as a short transition, but the target architecture should be OpenChat-native.
