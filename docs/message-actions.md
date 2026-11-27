# Message status and agent actions

Hold a message in the canonical client to open its actions.

- **Set status…** reads and sets Open, Closed or No status: the same states as
  Stream items, stored on the same owner Stream capture.
  - **Visible to: This chat / Only me.** "This chat" shares the capture with
    the source conversation through the Stream's existing `PINNED_IN` edge
    (marked `via:'message-status'`). Every participant then sees a compact
    chip under the message (`● Open · Ana`) and the item in the chat's Stream.
    "Only me" removes that pin, and the chip shows `· only you` to its owner
    alone. In the client, new statuses default to This chat; an existing status
    keeps its audience until the owner changes it.
  - Routes: `GET/PUT /api/chat/message-status?messageId=<encoded opaque ID>`.
    PUT accepts `{status:"none"|"open"|"closed", visibility?:"chat"|"private"}`.
    If `visibility` is omitted, the current audience is kept, and a new capture
    is private. This keeps API clients that predate visibility private.
    Clearing a status withdraws the pin. `GET /api/chat/message-status/conversation?conversationId=`
    returns every status shared with that chat, plus the caller's own private
    ones. It never returns another participant's private status.
  - Writes check current membership and deletion on both the read and the
    locked write. One deterministic owner/message Thought
    (`captureMethod:message-status`) is reused across retries. Its text is a
    bounded source excerpt; the source-message link keeps the full original.
    Clearing an absent status creates nothing.
  - Events: the owner's Stream gets `thought:created`/`thought:updated`.
    Participants get `message-status:changed` (and `thought:pinned`/`thought:unpinned`)
    only for shared statuses, or when a shared status is withdrawn; a withdrawal
    reports `status:"none"`, never the private value.
- **Get agent reply now** forwards the selected source and a reply request to
  the owner's private built-in OpenChat Agent using the existing forward API.
  The reply is for private review; nothing is sent back into the source chat.
- **Ask {name}'s agent** (on another person's message): their small built-in
  OpenChat agent answers right away *in the chat*, as a reply whose first line
  is `🤖 {name}'s OpenChat agent · not {name}`. That label is stored in the
  message text, so every client, notification and webhook shows it; new clients
  also draw a dashed outline. `POST /api/chat/agent-reply {messageId, question?}`.
  - **What it can read:** only what the owner already made visible to the asker:
    their consented public card projection (`projectCardForStranger`), the Stream items
    they pinned into this chat, their Context posts here (when the asker can read
    Context), and the selected message. It never reads private notes, the private
    people graph, unshared Thoughts, Secretary answers, other chats or account fields
    (`loadShareableContext` is the only reader; `profileAgent.integration.test.ts`
    seeds private canaries and asserts they never reach the model).
  - **Injection:** all chat text is passed as JSON data under a system prompt that
    treats it as untrusted. The model has no tools and at most 400 output tokens. Replies are
    capped at 1,200 characters, forged label lines are removed, and links are kept only
    when the owner's shared material contains them.
  - **Owner control and limits:** **opt-in.** The agent is off until its owner turns it on,
    because its replies are stored with the owner as sender. Auto replies shows a one-time
    prompt (*Let people ask my agent?* with *Turn on my agent* or *Not now*); either answer is
    recorded, and the switch stays there. When off, asking returns 409 `code:"off"`, and the Ask
    sheet says so up front via `GET /api/chat/agent-reply/availability?messageId=`
    (participants only; reveals only whether the author opted in, and nothing to a blocked
    person). The same switch governs agent-written auto-response rules: while it is off
    (unset or switched off) they write nothing, and Auto replies marks them paused. Each owner's agent is metered against a
    **$2 per month** cap from actual token usage (worst case reserved first), plus a global
    monthly ceiling (`OPENCHAT_PROFILE_AGENT_GLOBAL_MONTHLY_USD`, default 50). Rate
    limits: 10 asks per asker per hour, 5 per asker and owner, 40 per owner, and 2 per
    message. Human sessions only (agent keys and connectors are refused).
  - **Model and key:** the existing `ANTHROPIC_API_KEY` and `ASSISTANT_MODEL`
    (default `claude-haiku-4-5`). `OPENCHAT_PROFILE_AGENT_ENABLED=false` is the kill switch.
- **@agent / Ask my agent** (openchat-6zn): *your own* built-in agent answers
  about the current thread, in that chat. Three doors, one service
  (`services/threadAgent.ts`):
  typing `@agent` anywhere in a message (the composer offers it when you type `@`
  and says, before you send, that everyone in the chat will see the answer);
  the chat's **⋯** menu › **Ask @agent in this chat**; and holding your own message ›
  **Ask my agent** (`POST /api/chat/agent-reply {messageId, question?, agent:"mine"}`).
  The answer is a reply to the tagged or selected message, stored with you as sender,
  labelled `🤖 {you}'s OpenChat agent · not {you}` and `Asked by {you}`.
  - **What it can read:** only what everyone in the chat can already read: the newest
    40 live messages of that one conversation (600 characters each, 12,000 in total,
    voice notes by transcript) under the senders' public names, plus the Stream items
    and Context posts *you* shared there. Never private notes, the private people
    graph, your private names for contacts, private message statuses, the private
    assistant's page context, other chats, your card or account fields
    (`loadThreadContext` is the only reader; `threadAgent.integration.test.ts` seeds
    private canaries and asserts none reaches the model or the reply).
  - **The tag:** `@agent` as its own word, case-insensitive. `@agents`, `@agent-smith`,
    `name@agent.example` and lookalike characters are not tags. In a chat where another
    participant's name starts with "agent", the tag stays that person's mention and
    nothing runs. `@agent` alone means "catch me up".
  - **Injection:** every message is another participant's untrusted text, passed as
    JSON data. The model has no tools and at most 400 output tokens. Forged label lines are
    removed. A link survives only if *you* wrote it in this chat, so nobody can launder a
    link through your agent; other links become `[link removed]`.
  - **Consent and limits:** no standing opt-in, because each answer is your own explicit
    act and spends your own **$2 per month** allowance (same meter and global ceiling as
    above). 20 thread answers per person per hour, 8 per chat per hour, 2 per message.
    Signed-in people only: messages sent with an API key, a connector or an embedded
    session never trigger it. Not in direct chats with a bot or in announcement chats.
    The trigger never delays or fails the send; only the sender is told about progress
    or a refusal (`agent-reply:status` on their own sockets, codes only).
- **Auto replies** (Chats → Profile → Auto replies, and Settings → Auto replies) keeps
  the existing opt-in Secretary (exact quick answers) and adds **auto-response rules**:
  when I'm away, from these people, about these words → reply with my text, or let
  my agent write it. **Draft for my approval is the default.** Drafts wait on that
  screen with Send and Discard; recipients then see
  `🤖 Drafted by {name}'s OpenChat agent · approved by {name}`. *Send automatically* is
  an explicit per-rule choice, labelled `🤖 Automatic reply · {name}'s OpenChat agent, not {name}`,
  at most once per rule per chat every 6 hours. Rules apply in direct chats, after
  Secretary, and never to bots or automatic messages. Routes are under `/api/auto-responses`
  (`settings`, `rules`, `drafts`). Linking a person's own fuller agent is future work.
