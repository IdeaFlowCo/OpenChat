# Links in chat messages

Message text in the canonical Expo client recognizes `http://`, `https://`, and
`www.` URLs. The same renderer serves native iOS/Android and responsive web,
including the desktop wrapper. Tap a link to open it. `www.` destinations use
HTTPS. Surrounding sentence punctuation and unmatched closing brackets stay in
the message; balanced brackets within a URL remain part of its destination.
Arbitrary schemes, malformed URLs, and URLs containing credentials remain plain
text. Link previews use the same destination validation.

**More** on a message opens its actions. **Links · Open or copy** lists its
unique destinations, with labeled **Open link** and **Copy link** buttons.
Copy feedback appears in a polite accessibility status region; failures do not
claim success. Deleted messages expose no links. Existing message actions are
retained, and the main sheet scrolls on short screens.

On web, message text remains selectable. Links are real anchors, supporting
keyboard activation, modified clicks, and the browser's native link menu.
Right-clicking selected text keeps the browser menu; right-clicking unselected
non-link message content opens message actions. The labeled More button also
works with keyboard and voice navigation. On native, a link tap opens the URL;
a long press opens message actions without subsequently opening the URL.

## Verification

From `apps/server`, run:

```sh
npx vitest run test/messageLinks.mobile.test.ts test/groupOpen.mobile.test.ts --maxWorkers=1
```

The tests exercise parsing and actual message rendering, native tap/hold
boundaries, safe schemes, open failures, accessible link actions, and clipboard
success/rejection. They replace native OS APIs and do not substitute for a
physical-device gesture check before a native release.

Build the real RN-web chat fixture from the repo root:

```sh
node apps/server/test/conversationDisplay.browser.mjs <external-evidence-directory> --links
```

It uses the real message action sheet and replaces the clipboard OS boundary
with `window.copiedLink`. After Retry, inject a synthetic message through
`window.emitFixture('message:new', {...})`, as described in the fixture file.
Verify selection, context menus, Enter activation, copy feedback, and small-screen
scrolling. This fixture never sends messages to production.
