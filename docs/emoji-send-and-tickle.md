# Chat emoji send button and Tickle

Two small, playful chat features added 2026-10-25 (OpenChat-3aiu, OpenChat-m0xp).

## Chat emoji send button (OpenChat-3aiu)

The Messenger feature Facebook retired: when the composer is empty, the chat's
emoji sits where **Send** is.

- **Tap** sends the emoji as an ordinary message.
- **Press and hold** and it swells out of the composer; release to send it at
  the size reached. There are four sizes (`HOLD_LEVEL_MS` in
  `apps/mobile/src/utils/emojiMessage.ts`: 0 / 350 / 900 / 1600 ms), each
  crossing gives a light haptic tick on native.
- The button disappears as soon as anything is typed or attached, while a
  message is being edited, and while a voice note records. On native it sits
  beside the mic.
- A message that is exactly one emoji renders large and without a bubble (as in
  iMessage); a held send renders larger still.

### Choosing the emoji

**More › Chat emoji** in a conversation opens a picker: a grid of suggestions,
a field for any other emoji, and **Use default** (🍓). The choice is shared —
everyone in the chat sees the same emoji — and is stored on the conversation
as `quickEmoji`. Any participant may change it (`PATCH
/api/chat/conversations/:id { quickEmoji }`; `null` resets). Group renames keep
their owner-only rule on the same route.

### Wire format

The message is plain text whose `content` is the emoji. The size travels as
`emojiSize` (integer 1–4) on both send paths (`message:send` socket event and
`POST /api/chat/conversations/:id/messages`) and is stored on the message. The
server validates the range and only stores a size when the content is a
single emoji (`apps/server/src/services/emojiMessage.ts`), so older clients,
the Unlinked embed, exports and agents simply see an emoji message.

## Tickle (OpenChat-m0xp)

A nudge like WeChat's pat or Facebook's poke.

- **Direct chats:** More › **Tickle <name>**.
- **Any chat, including groups:** long-press (or **More**) on someone's message
  › **Tickle <name>**. Bots cannot be tickled; neither can you.
- The person tickled feels two heavy haptic taps and their open chat shakes;
  the sender's chat gives a short shake and a light tap as confirmation.
- Everyone in the chat sees a centered system line: *You tickled Alice*,
  *Jacob tickled you*, *Jacob tickled Alice*.
- The person tickled gets a push notification ("Jacob tickled you") unless
  they have muted the chat.
- Cooldown: one tickle per sender→recipient pair every 3 seconds
  (`TICKLE_COOLDOWN_MS`). The client shows the server's copy as a toast when
  it is too soon.

### Wire format

Clients emit `tickle:send { conversationId, targetUserId }` over the socket.
The server (`apps/server/src/services/tickle.ts`) checks both people are in
the conversation, drops the tickle silently when either has blocked the other
(like a blocked message send), and persists a server-authored card:
`messageType: 'card'`, `cardKind: 'tickle'`, `cardPayload: { fromUserId,
toUserId, fromName, toName }`, `content: "<from> tickled <to>"`. The card is
broadcast with `message:new` like any message, so history, previews, the
in-app banner and reconnect catch-up all work unchanged. Clients that do not
know the card kind show the content as text. The push `data.type` is
`tickle`.

## Tests

- `apps/server/test/emojiMessage.test.ts`, `apps/server/test/tickle.test.ts`
- `apps/mobile/src/utils/emojiMessage.test.ts`
- The server-hosted mobile render tests mock `Animated`, `Pressable` and the
  new haptic helpers.
