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
- **Auto replies** is reachable at Chats → Profile → Auto replies, as well as
  Settings → Auto replies. This is the existing opt-in Secretary mode: only
  owner-approved quick answers in direct chats, with visible auto-reply labels.
  Merely opening the configuration does not enable it or send any message.
  General personal-agent integration is outside this first increment.
