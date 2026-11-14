# iMessage thread mirror

Mirrors **one** iMessage thread into an OpenChat imported chat, so the thread's
owner can share it into a group conversation
([docs/shared-chat-mirrors.md](../../docs/shared-chat-mirrors.md)). Python 3,
standard library only.

It is not a capture tool for Messages in general: it reads the one thread named
in its config and nothing else.

## Safeguards

- The Messages database is opened read-only (`mode=ro`, `query_only`).
- The thread's row id **and** guid must both match, so a row id that means a
  different thread on another machine is refused.
- Phone numbers and email addresses never leave the machine. Each person is a
  keyed hash (HMAC with the config's `salt`); display names come from the
  config. Someone with no name there is uploaded unnamed.
- Attachments, tapbacks, stickers and group events are not uploaded. An
  attachment becomes a "not mirrored" placeholder; an unsent message becomes
  "deleted by the sender".
- The upload uses the mirror's own write-only sync token, which can touch only
  that mirror. The token and config files must be `chmod 600`.
- Sync logs counts only. The explicit `extract` and `payload` commands output
  chat data for transfer or review; handle that output privately.
- Message text is data. Nothing in it is executed or interpreted.

## Config

A JSON file outside the repository, `chmod 600`:

```json
{
  "chatRowId": 123,
  "chatGuid": "any;+;…",
  "salt": "at least 24 random characters, kept on this machine",
  "title": "Title to show for the mirror",
  "ownerName": "Your name",
  "participants": { "+15550100001": "Ada Example" },
  "server": "https://chat.ideaflow.app",
  "mirrorChatId": "id of the imported chat",
  "tokenFile": "~/.config/openchat/mirror.token"
}
```

`server`, `mirrorChatId` and `tokenFile` are needed only for `sync`.

## Use

```bash
python3 mirror.py selftest                       # invented data; safe anywhere
python3 mirror.py payload --config mirror.json   # review exactly what would be uploaded
python3 mirror.py sync --config mirror.json --dry-run
python3 mirror.py sync --config mirror.json
```

When the Messages database is on another Mac than the config and token:

```bash
ssh that-mac "python3 - extract --chat-rowid 123 --chat-guid 'any;+;…'" < mirror.py \
  | python3 mirror.py sync --config mirror.json --rows -
```

The first import of a thread is done by its owner (an import through
`PUT /api/imported-chats/import`, which creates the mirror and returns its id);
the owner then issues the sync token. Syncs are idempotent: a message is keyed
by its Messages guid, so running again changes nothing that has not changed.
