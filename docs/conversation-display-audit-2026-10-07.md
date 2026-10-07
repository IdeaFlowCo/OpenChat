# Conversation display and notification audit — OpenChat-f8kv

Jacob reported intermittently blank conversations and Context views, possibly
with Harrison. The audit confirmed client defects; it did not establish which
one caused that particular incident. The current production container started
at 2026-10-07T05:44:02Z; its available logs contained no corresponding errors.
A deployment interruption could expose the failed-load path below.

## Corrected behavior

- Failed message loads show an error and Retry instead of suggesting the chat
  is empty. Socket reconnect reloads the visible history even when catch-up is
  truncated. Cached messages remain visible on transient failure.
- Slow history responses merge messages and edits received during the request.
  Earlier loads and pagination cannot replace a newly selected/reopened thread.
- Compact chat screens reactivate on focus, including back navigation to a
  screen that remained mounted. The desktop parent owns selection, so mounting
  its detail pane does not clear a newer selection or reset Context to Chat.
- Notification taps, in-app banners and Context URLs route through
  Main → ChatsTab → Chat. Destinations wait for navigation, login and onboarding
  rather than being dropped after a fixed startup delay. Native cold-start taps
  are recovered; duplicate launch responses do not override newer taps.
- Foreground notification suppression follows focused Chat visibility and a
  connected socket; viewing Context does not suppress incoming chat alerts.

## Verification and boundaries

Behavioral tests exercise the actual ChatProvider, ChatScreen and native
notification listener with mocked OS/network boundaries. They cover failed
loads/retry, slow history versus live messages/edits, reconnect, stale pagination,
focus return, desktop ownership, cold-start notifications, duplicate responses,
and nested Context routing. Existing Context tests cover errors, refresh,
account isolation and concurrent writes. No real messages or test notifications
were sent to contacts.

Browser background push remains a separate gap, tracked as OpenChat-7o4h:
the canonical RN-web client skips native push registration and its service
worker has no push/notificationclick handlers. Server web-push support alone
does not enable notifications in the installed web app. Context currently
refreshes on focus/foreground and periodically, rather than via push events.
Physical iPhone delivery through APNs/Expo still needs a device smoke check;
unit tests do not establish OS delivery reliability.
