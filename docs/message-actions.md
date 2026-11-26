# Message status and agent actions

Hold a message in the canonical client to open its actions.

- **Message status…** reads/sets Open, Closed or No status in the owner's Stream.
  The route is `GET/PUT /api/chat/message-status?messageId=<encoded opaque ID>`;
  PUT accepts `{status:"none"|"open"|"closed"}`. It checks current membership and
  deletion on both reads and locked writes. One deterministic owner/message
  Thought (`captureMethod:message-status`) is reused across retries. Its text is a bounded source excerpt; the source-message link retains the full original. Clearing an
  absent status creates nothing. The capture is not pinned and no chat message
  is sent. Only the owner receives Stream update events. Status captures stay
  distinct from ordinary saved copies in the legacy deduper.
- **Get agent reply now** forwards the selected source and a reply request to
  the owner's private built-in OpenChat Agent using the existing forward API.
  The reply is for private review; nothing is sent back into the source chat.
- **Auto replies** is reachable at Chats → Profile → Auto replies, as well as
  Settings → Auto replies. This is the existing opt-in Secretary mode: only
  owner-approved quick answers in direct chats, with visible auto-reply labels.
  Merely opening the configuration does not enable it or send any message.
  General personal-agent integration is outside this first increment.
