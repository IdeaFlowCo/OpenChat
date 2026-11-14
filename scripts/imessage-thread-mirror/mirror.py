#!/usr/bin/env python3
"""Mirror ONE iMessage thread into an OpenChat imported chat (OpenChat-c8to.7).

Reads the Messages database read-only, for exactly the one thread named in a
local config file, and uploads its text messages with that mirror's own
write-only sync token. See docs/shared-chat-mirrors.md for what is stored
where. Standard library only.

  mirror.py extract --config FILE              rows of the one thread, as JSON on stdout
  mirror.py extract --chat-rowid N --chat-guid G   the same, without a config on that machine
  mirror.py sync --config FILE [--rows FILE|-] [--dry-run]
  mirror.py payload --config FILE [--rows FILE|-]   the upload body, for review
  mirror.py selftest                           checks against an invented database

`extract` and `sync` may run on different machines: run `extract` where the
Messages database is and pipe its output to `sync --rows -`.

What never leaves the machine: phone numbers and email addresses (each person
becomes a keyed hash), attachments, tapbacks, group events, and every other
thread. Message text is data: nothing in it is ever executed or interpreted.
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import sqlite3
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

APPLE_EPOCH = 978307200  # 2001-01-01T00:00:00Z
CHUNK = 2000             # the import API accepts 5,000 messages per request
OBJECT_REPLACEMENT = "￼"
NOTE = "Attachments, tapbacks and group events are not mirrored."


class MirrorError(Exception):
    pass


# ── Config ────────────────────────────────────────────────────────────────────

def load_config(path):
    path = os.path.expanduser(path)
    mode = os.stat(path).st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise MirrorError("Config file must be readable by its owner only (chmod 600)")
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    for key in ("chatRowId", "chatGuid", "salt", "title", "ownerName"):
        if not config.get(key):
            raise MirrorError("Config is missing %s" % key)
    if len(str(config["salt"])) < 24:
        raise MirrorError("Config salt must be at least 24 random characters")
    if not isinstance(config.get("participants", {}), dict):
        raise MirrorError("Config participants must map a handle to a display name")
    return config


def read_token(config):
    path = os.path.expanduser(config.get("tokenFile") or "")
    if not path:
        raise MirrorError("Config is missing tokenFile")
    if os.stat(path).st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise MirrorError("Token file must be readable by its owner only (chmod 600)")
    with open(path, encoding="ascii") as handle:
        token = handle.read().strip()
    if not token.startswith("ocm_"):
        raise MirrorError("Token file does not hold a mirror sync token")
    return token


# ── Reading the one thread ────────────────────────────────────────────────────

def decode_attributed_body(blob):
    """Plain text of a typedstream NSAttributedString, or None."""
    if not blob:
        return None
    data = bytes(blob)
    start = data.find(b"NSString")
    if start < 0:
        return None
    rest = data[start + 8:]
    plus = rest.find(b"+")
    if plus < 0 or plus > 16:
        return None
    rest = rest[plus + 1:]
    if not rest:
        return None
    length, rest = rest[0], rest[1:]
    if length == 0x81:
        length, rest = int.from_bytes(rest[:2], "little"), rest[2:]
    elif length == 0x82:
        length, rest = int.from_bytes(rest[:4], "little"), rest[4:]
    if length > len(rest):
        return None
    return rest[:length].decode("utf-8", "replace")


def iso(apple_time):
    if not apple_time:
        return None
    # Nanoseconds since 2001 on current macOS; whole seconds on very old databases.
    seconds = apple_time / 1e9 if abs(apple_time) > 1e12 else float(apple_time)
    moment = datetime.datetime.fromtimestamp(seconds + APPLE_EPOCH, datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (moment.microsecond // 1000)


def columns(db, table):
    return {row[1] for row in db.execute("PRAGMA table_info(%s)" % table)}


def extract(config, database=None):
    """Rows of the configured thread only. Opens the database read-only."""
    path = os.path.expanduser(database or config.get("database") or "~/Library/Messages/chat.db")
    db = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path), uri=True)
    try:
        db.execute("PRAGMA query_only = ON")
        # Both the row id and the guid must name the same thread, so a row id that
        # means another thread on another machine can never be mirrored by mistake.
        chat = db.execute("SELECT ROWID FROM chat WHERE ROWID = ? AND guid = ?", (int(config["chatRowId"]), str(config["chatGuid"]))).fetchall()
        if len(chat) != 1:
            raise MirrorError("The configured thread was not found (row id and guid must both match)")
        chat_id = chat[0][0]
        has = columns(db, "message")
        optional = lambda name: ("m.%s" % name) if name in has else "NULL"
        rows = db.execute(
            """SELECT m.guid, m.date, m.is_from_me, h.id, m.text, m.attributedBody, m.cache_has_attachments,
                      m.associated_message_type, m.item_type, %s, %s,
                      (SELECT a.mime_type FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
                        WHERE j.message_id = m.ROWID ORDER BY a.ROWID LIMIT 1)
               FROM chat_message_join c JOIN message m ON m.ROWID = c.message_id
               LEFT JOIN handle h ON h.ROWID = m.handle_id
               WHERE c.chat_id = ? ORDER BY m.date, m.ROWID""" % (optional("date_edited"), optional("date_retracted")),
            (chat_id,)).fetchall()
        members = [row[0] for row in db.execute(
            "SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ? ORDER BY h.id", (chat_id,))]
    finally:
        db.close()
    out = []
    for guid, date, from_me, handle, text, body, has_attachments, associated, item_type, edited, retracted, mime in rows:
        out.append({
            "guid": guid, "sentAt": iso(date), "fromMe": bool(from_me), "handle": handle,
            "text": text if text else decode_attributed_body(body),
            "hasAttachments": bool(has_attachments), "mime": mime,
            "associatedType": associated or 0, "itemType": item_type or 0,
            "editedAt": iso(edited), "retracted": bool(retracted),
        })
    return {"schema": "imessage-thread-rows/1", "readAt": iso_now(), "members": members, "rows": out}


def iso_now():
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)


# ── Building the upload ───────────────────────────────────────────────────────

def keyed(config, kind, value):
    """A stable key for a person or thread that cannot be turned back into the handle."""
    return hmac.new(str(config["salt"]).encode(), ("%s:%s" % (kind, value)).encode(), hashlib.sha256).hexdigest()[:40]


def media_type(mime):
    if not mime:
        return "attachment"
    family = mime.split("/")[0]
    return family if family in ("image", "video", "audio") else "file"


def build_payloads(config, extracted):
    if extracted.get("schema") != "imessage-thread-rows/1":
        raise MirrorError("Unrecognised rows file")
    names = {str(handle): str(name) for handle, name in (config.get("participants") or {}).items()}
    owner_key = keyed(config, "person", "owner")
    participants = {owner_key: {"sourceKey": owner_key, "displayName": config["ownerName"], "nameSource": "owner", "isOwner": True, "membership": "current"}}

    def person(handle, membership):
        key = keyed(config, "person", handle)
        if key not in participants:
            entry = {"sourceKey": key, "membership": membership}
            if names.get(handle):
                entry.update(displayName=names[handle], nameSource="contact")
            participants[key] = entry
        elif membership == "current":
            participants[key]["membership"] = "current"
        return key

    for handle in extracted.get("members", []):
        person(handle, "current")
    messages, text_rows, other_rows = [], 0, 0
    for row in extracted["rows"]:
        # Tapbacks, stickers and group events (renames, joins) are not messages.
        if row["associatedType"] >= 1000 or row["itemType"] != 0 or not row["guid"] or not row["sentAt"]:
            other_rows += 1
            continue
        if not row["fromMe"] and not row["handle"]:
            other_rows += 1
            continue
        sender = owner_key if row["fromMe"] else person(row["handle"], "unknown")
        text = (row["text"] or "").replace(OBJECT_REPLACEMENT, "").replace("\x00", "").strip()
        message = {"sourceMessageId": row["guid"], "senderKey": sender, "sentAt": row["sentAt"]}
        if row["retracted"]:
            message["kind"] = "deleted"
            other_rows += 1
        elif text:
            message.update(kind="text", text=text[:20000])
            text_rows += 1
        elif row["hasAttachments"]:
            message.update(kind="media", mediaType=media_type(row["mime"]))
            other_rows += 1
        else:
            other_rows += 1
            continue
        if row["editedAt"] and not row["retracted"]:
            message["editedAt"] = row["editedAt"]
        messages.append(message)
    source = {
        "network": "imessage", "accountKey": config.get("accountKey") or keyed(config, "account", "owner"),
        "chatKey": keyed(config, "thread", config["chatGuid"]), "chatType": "group" if len(participants) > 2 else "direct", "title": config["title"],
    }
    coverage = {
        "asOf": extracted["readAt"], "method": "imessage-chat-db", "complete": True, "note": NOTE,
        "sourceRowCounts": {"total": len(extracted["rows"]), "text": text_rows, "nonText": other_rows},
    }
    chunks = [messages[i:i + CHUNK] for i in range(0, len(messages), CHUNK)] or [[]]
    return [{"schemaVersion": 1, "source": source, "coverage": coverage, "participants": list(participants.values()), "messages": chunk} for chunk in chunks]


# ── Upload ────────────────────────────────────────────────────────────────────

def upload(config, payloads, dry_run):
    server = str(config.get("server") or "").rstrip("/")
    host = urllib.parse.urlparse(server).hostname or ""
    if not (server.startswith("https://") or host in ("127.0.0.1", "localhost")):
        raise MirrorError("Config server must be an https address")
    if not config.get("mirrorChatId"):
        raise MirrorError("Config is missing mirrorChatId")
    token = read_token(config)
    url = "%s/api/imported-chats/sync/%s%s" % (server, urllib.parse.quote(str(config["mirrorChatId"]), safe=""), "?dryRun=1" if dry_run else "")
    totals = {"created": 0, "edited": 0, "deleted": 0, "unchanged": 0, "conflicts": 0}
    for payload in payloads:
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="PUT",
                                         headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "openchat-imessage-thread-mirror/1"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = json.load(error).get("error", "")
            except Exception:
                pass
            raise MirrorError("Server refused the sync (%s) %s" % (error.code, detail)) from None
        for key in ("created", "edited", "deleted", "unchanged"):
            totals[key] += int(result["counts"]["messages"].get(key, 0))
        totals["conflicts"] += int(result.get("conflicts", 0))
    return totals


# ── Self-test on invented data ────────────────────────────────────────────────

def typedstream(text):
    raw = text.encode()
    length = bytes([len(raw)]) if len(raw) < 0x80 else b"\x81" + len(raw).to_bytes(2, "little")
    return b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+" + length + raw + b"\x86\x84\x02iI\x01"


def selftest():
    folder = tempfile.mkdtemp(prefix="mirror-selftest-")
    path = os.path.join(folder, "chat.db")
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER, text TEXT, attributedBody BLOB,
          cache_has_attachments INTEGER, associated_message_type INTEGER, item_type INTEGER, date_edited INTEGER, date_retracted INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, mime_type TEXT);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
        INSERT INTO chat VALUES (7, 'thread-guid-synthetic'), (8, 'another-thread');
        INSERT INTO handle VALUES (1, '+15550100001'), (2, '+15550100002'), (3, '+15550100003');
        INSERT INTO chat_handle_join VALUES (7, 1), (7, 2), (8, 3);
        INSERT INTO attachment VALUES (1, 'image/jpeg');
    """)
    base = 800000000  # seconds after the Apple epoch: a date in 2026
    ns = lambda seconds: (base + seconds) * 1000000000
    long_text = "long " * 40
    rows = [
        (1, "g-1", ns(100), 0, 1, "hello https://example.org/a", None, 0, 0, 0, 0, 0),
        (2, "g-2", ns(200), 1, 0, None, typedstream("from the owner"), 0, 0, 0, 0, 0),
        (3, "g-3", ns(300), 0, 2, None, typedstream(long_text), 0, 0, 0, ns(350), 0),
        (4, "g-4", ns(400), 0, 2, "Liked “hello”", None, 0, 2001, 0, 0, 0),
        (5, "g-5", ns(500), 1, 0, OBJECT_REPLACEMENT, None, 1, 0, 0, 0, 0),
        (6, "g-6", ns(600), 0, 1, None, None, 0, 0, 2, 0, 0),
        (7, "g-7", ns(700), 0, 1, "took it back", None, 0, 0, 0, 0, ns(710)),
        (8, "g-8", ns(800), 0, 3, "a different thread", None, 0, 0, 0, 0, 0),
    ]
    db.executemany("INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO chat_message_join VALUES (?,?)", [(7, i) for i in range(1, 8)] + [(8, 8)])
    db.execute("INSERT INTO message_attachment_join VALUES (5, 1)")
    db.commit()
    db.close()
    config = {"chatRowId": 7, "chatGuid": "thread-guid-synthetic", "salt": "s" * 32, "title": "Synthetic thread", "ownerName": "Owner Example",
              "participants": {"+15550100001": "Ada Example"}}
    try:
        extract(dict(config, chatGuid="another-thread"), path)
        raise AssertionError("a row id and guid that disagree must be refused")
    except MirrorError:
        pass
    extracted = extract(config, path)
    assert [row["guid"] for row in extracted["rows"]] == ["g-%d" % i for i in range(1, 8)], "only the configured thread is read"
    assert extracted["rows"][1]["text"] == "from the owner" and extracted["rows"][2]["text"] == long_text
    payloads = build_payloads(config, extracted)
    assert len(payloads) == 1
    body = payloads[0]
    raw = json.dumps(body)
    assert "+1555" not in raw and "a different thread" not in raw, "handles and other threads never appear in the upload"
    assert "asks" not in body and all("profileFacts" not in p for p in body["participants"])
    kinds = [(m["sourceMessageId"], m["kind"]) for m in body["messages"]]
    assert kinds == [("g-1", "text"), ("g-2", "text"), ("g-3", "text"), ("g-5", "media"), ("g-7", "deleted")], kinds
    assert body["messages"][3]["mediaType"] == "image" and "text" not in body["messages"][4]
    assert body["messages"][2]["editedAt"] == "2026-05-09T06:19:10.000Z" and body["messages"][0]["sentAt"] == "2026-05-09T06:15:00.000Z"
    named = sorted(p.get("displayName") or "" for p in body["participants"])
    assert named == ["", "Ada Example", "Owner Example"], named
    assert sum(1 for p in body["participants"] if p.get("isOwner")) == 1
    assert body["coverage"]["sourceRowCounts"] == {"total": 7, "text": 3, "nonText": 4}
    assert body["source"]["network"] == "imessage" and body["source"]["chatType"] == "group"
    assert build_payloads(config, extracted)[0]["source"] == body["source"], "keys are stable between runs"
    assert build_payloads(dict(config, salt="t" * 32), extracted)[0]["source"]["chatKey"] != body["source"]["chatKey"]
    os.remove(path)
    os.rmdir(folder)
    print("selftest ok")


# ── Command line ──────────────────────────────────────────────────────────────

def rows_from(args, config):
    if args.rows == "-":
        return json.load(sys.stdin)
    if args.rows:
        with open(args.rows, encoding="utf-8") as handle:
            return json.load(handle)
    return extract(config)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("extract", "payload", "sync"):
        command = commands.add_parser(name)
        command.add_argument("--config", required=name != "extract")
        if name == "extract":
            # Where the database is on another machine than the config: name the thread directly.
            command.add_argument("--chat-rowid", type=int)
            command.add_argument("--chat-guid")
            command.add_argument("--database")
        if name != "extract":
            command.add_argument("--rows", help="rows from `extract` (a file, or - for standard input); default reads the local database")
        if name == "sync":
            command.add_argument("--dry-run", action="store_true")
    commands.add_parser("selftest")
    args = parser.parse_args(argv)
    try:
        if args.command == "selftest":
            selftest()
            return 0
        if args.command == "extract" and not args.config:
            if not args.chat_rowid or not args.chat_guid:
                raise MirrorError("extract needs --config, or both --chat-rowid and --chat-guid")
            json.dump(extract({"chatRowId": args.chat_rowid, "chatGuid": args.chat_guid}, args.database), sys.stdout)
            return 0
        config = load_config(args.config)
        if args.command == "extract":
            json.dump(extract(config, args.database), sys.stdout)
            return 0
        payloads = build_payloads(config, rows_from(args, config))
        if args.command == "payload":
            json.dump(payloads, sys.stdout, indent=1)
            return 0
        totals = upload(config, payloads, args.dry_run)
        # Counts only: message text and names are never logged.
        print(json.dumps({"dryRun": bool(args.dry_run), "messages": totals, "syncedAt": iso_now()}))
        return 0
    except MirrorError as error:
        print("mirror: %s" % error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
