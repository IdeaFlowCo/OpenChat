# Offline chat

OpenChat keeps recent chat history on the device and queues outgoing text and
replies when the connection drops. Open a saved conversation from Chats, compose
normally, and tap Send. The message shows **Waiting to send** until OpenChat
connects, then **Sending…**, then the normal sent status. Keep OpenChat open or
reopen it after reconnecting; background delivery while the app is suspended is
not guaranteed. You must have signed in online at least once.

Queued messages survive an app restart. Transport failures retry automatically;
server rejections show **Failed to send**, with **Retry** and **Remove** controls.
Retries keep the original message ID, including after a lost acknowledgement,
so the server can deduplicate them. Messages are saved locally before the
composer accepts the send. If storage is full, the text stays in the composer.

The cache retains the 200 most recent conversation summaries and up to 100
messages in each of 30 recently viewed/updated conversations, with an additional
size cap. Only previously loaded history is available; older history, search,
new photo/voice uploads, edits, and downloads require a connection. Attachments
already uploaded before a connection loss retain their references in the queue;
attachment bytes are not cached for offline playback or viewing.

Caches and pending sends are isolated by account. Explicit sign-out clears that
account's local history and pending sends. Expired authentication preserves
pending messages for the same account's next sign-in. Removing a conversation
from the server's authorized list evicts its saved history on refresh. Membership
changes cannot be discovered while a device is offline.

On the web, the service worker saves the build's public HTML, scripts, styles,
fonts and icons as one installation. Visit online and allow the worker to finish
installing before going offline. API responses, auth callbacks, uploaded media,
and cross-origin requests are excluded. Browser storage eviction/clearing can
remove offline data; this cache is not a backup. Native storage uses the existing
AsyncStorage dependency. No new dependencies or schema migrations are required.

Implementation: `apps/mobile/src/services/offlineChat.ts`,
`apps/mobile/src/contexts/ChatContext.tsx`, and
`infra/prepare-offline-shell.mjs`. Regression tests cover mounted-provider
restart/reconnection/account isolation, durable storage failure and eviction,
and service-worker fetch boundaries.
