# Conversation display and notification audit — OpenChat-f8kv

Jacob reported intermittently blank conversations and Context views, possibly
with Harrison. The audit confirmed client defects; it did not establish which
one caused that particular incident. The current production container started
at 2026-10-07T05:44:02Z; its available logs contained no corresponding errors.
A deployment interruption could expose the failed-load path below.

## Corrected behavior

- Message-loading recovery is documented in the
  [user guide](../README.md#messages-and-stream). Socket reconnect reloads the
  latest history page even when catch-up is truncated.
- Slow history responses merge messages and edits received during the request.
  Earlier loads and pagination cannot replace a newly selected/reopened thread.
- Compact chat screens reactivate on focus, including back navigation to a
  screen that remained mounted. The desktop parent owns selection, so mounting
  its detail pane does not clear a newer selection or reset Context to Chat.
- `conversationNavigation.ts` owns the shared Main → ChatsTab → Chat routing
  queue. The native listener recovers cold-start responses and prevents older
  launch responses from overriding newer taps. See the
  [user guide](../README.md#notifications-and-conversation-links) for visible behavior.

## Verification and boundaries

Behavioral tests exercise the actual ChatProvider, ChatScreen and native
notification listener with mocked OS/network boundaries. They cover failed
loads/retry, slow history versus live messages/edits, reconnect, stale pagination,
focus return, desktop ownership, cold-start notifications, duplicate responses,
and nested Context routing. Existing Context tests cover errors, refresh,
account isolation and concurrent writes. No real messages or test notifications
were sent to contacts.

See [notification delivery limits](../README.md#notifications-and-conversation-links)
for the browser push follow-up and physical-device verification gap, and
[Context back-channel](context-backchannel.md) for its refresh contract.
