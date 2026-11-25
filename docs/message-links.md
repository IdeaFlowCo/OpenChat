# Links in chat messages

Message text in the canonical Expo client recognizes `http://`, `https://`,
`www.` URLs and bare domains such as `unlinked.ai` or `chat.ideaflow.app/x`.
Bare domains link only for a fixed list of common TLDs (`BARE_DOMAIN_TLDS` in
`apps/mobile/src/utils/messageLinks.ts`), so file names like `notes.md` or
`app.py`, `Node.js`, and the domain of an email address stay plain text. Agent
messages rendered as Markdown use the same bare-domain rule. The same renderer serves native iOS/Android and responsive web,
including the desktop wrapper. Tap a link to open it. `www.` and bare-domain
destinations use HTTPS. Surrounding sentence punctuation and unmatched closing brackets stay in
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

Link preview cards sit below the bubble on their own opaque surface, the same
for sent and received messages, so they read on the conversation background in
both themes.

## One set of rules everywhere

Chat bubbles, Back channel posts, Stream entries and agent Markdown share one
tokenizer, `apps/mobile/src/utils/richLinks.ts`. Scanning left to right:

| Written as | Shown as |
|---|---|
| `[label](https://…)`, `[label](www.…)`, `[label](bare.domain/…)` | A link showing `label` |
| `https://…`, `www.…`, a bare domain | A link showing the address |
| `[label](file:///…)`, `[label](/Users/…)` | A **path** showing 📁 `label` |
| `file:///…`, or a bare path under `/Users/`, `/home/`, `/Volumes/`, `~/`, `C:\` and a few system roots | A **path** showing 📁 and the decoded path |
| `[label](javascript:…)`, `data:`, `vbscript:`, `intent:`, any other scheme, an address with credentials, a malformed address | Exactly what was typed |

A person's message gets links by these rules and no other formatting; an
agent's message is also rendered as Markdown. Joining every part's source text
gives the original back, so no character is ever lost.

**Paths.** A browser will not open a `file:` address from a web page, so a
path is never an anchor. It is a button: pressing it copies the path and shows
"Path copied: paste in Finder (⇧⌘G)". The full path is the tooltip on web and
the screen-reader label everywhere. `file:///Users/a/My%20Notes/x.html` and
`file://localhost/…` decode to `/Users/a/My Notes/x.html`;
`file:///C:/Users/a/x` to `C:/Users/a/x`. A `%` that does not start a `%XX`
escape is a literal character of the name (`file:///tmp/100%done.txt`). A file
link labelled with its own address shows the decoded path. A `file:` address naming another machine
(`file://server/share/…`) is not a local path and stays as typed, as does any
path that would carry a control, invisible or direction-changing character or
one of `; | & $ \` < > " ! { }`, or that goes on after a space to a flag, an
assignment or a second path (`[docs](/tmp/x -o /tmp/y)` copies nothing; a name
like `2024 - Taxes` is fine, since a dash is a flag only when a character
follows it). A line
that is nothing but a bare path keeps its spaces: one that ends in a separator
or in an extension on a name with few spaces (`/Users/sam/my notes/plan.html`),
or that reads like a name rather than a sentence (`/Users/sam/My Projects/Index
Folder`: no closing punctuation, no lowercase word after a space). A line that goes on to a
flag, an assignment or a second path (`/tmp/a -o /tmp/b`) is a command, so each
path in it stands alone. Otherwise a bare path ends at the next space. A markdown destination that is a path may
contain spaces and one level of balanced parentheses (`Report (final).pdf`). In an agent's Markdown, paths are read from the raw text before
emphasis, so `/Users/me/__pycache__/x` copies exactly. If a desktop shell provides `window.ideaflowDesktop.revealPath(path)` (or the
older name `openPath`), it is called instead of copying. Its contract: the shell must reveal the item (for
example in Finder) or ask before launching anything, because the path is
someone else's text. A thrown error, `false`, or a non-empty string result counts
as failure and the path is copied. No shell provides it today. A `file:` address
must be written `file://…`, and its decoded path may not begin with `//` or a backslash pair. The button's
accessible name is its label followed by "(copy path …)". If the clipboard refuses, the notice
reads "Couldn't copy. Path: …" so the path can still be read. These rules
are shared with the Ideaflow Dashboard's description field; a markdown
destination keeps one level of balanced parentheses.

**Hidden characters.** An address or path carrying a control, invisible or
direction-changing character (the set is `INVISIBLE` in `utils/messageLinks.ts`,
shared with the Dashboard: control characters, every Unicode default-ignorable
code point, the braille blank and the interlinear annotation marks) stays exactly as typed, in people's messages and in
an agent's Markdown alike; an agent's address is judged as written, before the
URL parser can normalise it into another host.

**Named links.** `[label](address)` can show one name and go somewhere else.
On web, hovering shows the real address as for any link; **Links · Open or
copy** in the message actions lists the address under the label.

**Show links as text** (Settings › Appearance, off by default, stored on the
device) shows message and Stream text exactly as written, with nothing linked.

A collapsed Stream entry is one plain line; expand it to use its links.
Holding a link or a path opens the card's or message's actions.

Link preview cards sit below the bubble on their own opaque surface, the same
for sent and received messages.

## Verification

For the shared rules and the Stream: `npx vitest run test/richLinks.mobile.test.ts test/streamLinks.mobile.test.ts --maxWorkers=1`.

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
