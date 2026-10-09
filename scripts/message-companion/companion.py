#!/usr/bin/env python3
"""Private, replayable iMessage capture. Standard library only; never writes chat.db.

archive scans authored messages into an owner-local outbox; sync uploads that outbox;
watch repeats both. Sending is an explicit CLI command delegated to installed imsg.
"""
import argparse
import base64
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
import unicodedata
from datetime import datetime, timezone

APPLE_EPOCH = 978307200
SAVE_EMOJI = '🔖'
PIN_EMOJI = '📌'
TAG = re.compile(r'(?<![\w/#&=])#([^\W_][\w-]*|_[\w-]+)', re.UNICODE)
URL = re.compile(r'https?://\S+', re.I)


def confidential(text):
    """Keep explicitly confidential/identifier-like values in their canonical local source.
    This is a conservative routing rule, not a guarantee of semantic detection.
    """
    if re.search(r'#confidential\b|(?:ssn|social security|passport|driver.?s? licen[cs]e|tax.?id|account number|routing number|card number|confidential)\s*[:#=-]?\s*[A-Z0-9 -]{5,}', text, re.I):
        return True
    if re.search(r'(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)',text):
        return True
    for match in re.finditer(r'(?<!\d)(?:\d[ -]?){13,19}(?!\d)',text):
        digits=[int(d) for d in match.group() if d.isdigit()]
        if len(digits) in range(13,20) and len(set(digits))>1:
            total=sum((d*2-9 if d*2>9 else d*2) if i%2 else d for i,d in enumerate(reversed(digits)))
            if total%10==0: return True
    return False


def tags_in(text):
    # A URL fragment is not a capture gesture. Preserve case in source, normalize tags.
    return list(dict.fromkeys(m.group(1) for m in TAG.finditer(URL.sub('', text))))


def utf16_length(value):
    return len(value.encode('utf-16-le')) // 2


def validate_tags(tags):
    if not isinstance(tags, list) or len(tags) > 50:
        raise ValueError('Invalid tags')
    normalized = []
    for tag in tags:
        if not isinstance(tag, str) or not tag or utf16_length(tag) > 256:
            raise ValueError('Invalid tag')
        tag = unicodedata.normalize('NFKC', tag).lower()
        if not tag or not (tag[0] == '_' or unicodedata.category(tag[0])[0] in 'LN'):
            raise ValueError('Invalid tag')
        if any(c not in '_-' and unicodedata.category(c)[0] not in 'LMN' for c in tag):
            raise ValueError('Invalid tag')
        if tag not in normalized:
            normalized.append(tag)
    return normalized


def validate_capture(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid capture')
    def string(text, maximum, empty=False):
        if not isinstance(text, str) or (not empty and not text.strip()) or utf16_length(text) > maximum:
            raise ValueError('Invalid capture field')
    def date(text):
        string(text, 40)
        if not re.match(r'^\d{4}-\d\d-\d\dT', text):
            raise ValueError('Invalid capture date')
        datetime.fromisoformat(text.replace('Z', '+00:00'))
    if value.get('channel') != 'imessage' or not isinstance(value.get('pinned'), bool):
        raise ValueError('Invalid capture')
    if value.get('destination') not in ('stream', 'note', 'contact') or value.get('captureMethod') not in ('inline', 'reply', 'reaction', 'manual'):
        raise ValueError('Invalid capture')
    for field, maximum in (('sourceAccount',200),('sourceThreadId',400),('threadTitle',200),('sourceMessageId',400),('triggerMessageId',1000),('text',256000)):
        string(value.get(field), maximum)
    string(value.get('triggerText'), 256000, empty=True)
    participants = value.get('participants')
    if not isinstance(participants, list) or len(participants) > 100:
        raise ValueError('Invalid participants')
    for participant in participants:
        string(participant, 200)
    validate_tags(value.get('tags'))
    for field in ('sourceAt', 'capturedAt'):
        date(value.get(field))
    if 'contactDetails' in value:
        details = value['contactDetails']
        if not isinstance(details, dict) or not isinstance(details.get('fields'), list) or len(details['fields']) > 40 or utf16_length(json.dumps(details, ensure_ascii=False, separators=(',', ':'))) > 16000:
            raise ValueError('Invalid contact details')
        date(details.get('modifiedAt'))
        for field in details['fields']:
            if not isinstance(field, dict):
                raise ValueError('Invalid contact field')
            string(field.get('label'), 80)
            string(field.get('value'), 2000)


def body_text(row):
    if row.get('text') is not None:
        return row['text'], True
    blob = row.get('attributedBody')
    if not blob:
        return '', True
    # Recognize only the common typedstream NSString envelope. Unknown encodings
    # go to the local review queue with original bytes, never lossy replacement.
    try:
        start = blob.index(b'NSString') + len(b'NSString')
        data = blob[start:]
        if len(data) < 6 or data[2:5] != b'\x84\x01+':
            return '', False
        first = data[5]
        offset = 6
        if first in (0x81, 0x82):
            size = 2 if first == 0x81 else 4
            length = int.from_bytes(data[offset:offset+size], 'little')
            offset += size
        elif first < 0x80:
            length = first
        else:
            return '', False
        if length < 0 or len(data) < offset + length:
            return '', False
        return data[offset:offset+length].decode('utf-8'), True
    except (ValueError, UnicodeDecodeError):
        return '', False


def apple_date(value):
    seconds = value / 1_000_000_000 if abs(value) > 10**12 else value
    return datetime.fromtimestamp(seconds + APPLE_EPOCH, timezone.utc).isoformat().replace('+00:00', 'Z')


def readonly(path):
    conn = sqlite3.connect(Path(path).expanduser().resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def private_db(path):
    path = Path(path).expanduser()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.umask(0o077)
    conn = sqlite3.connect(path)
    os.chmod(path, 0o600)
    conn.executescript('''
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS review (id TEXT PRIMARY KEY, reason TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint (source TEXT PRIMARY KEY, rowid INTEGER NOT NULL);
    ''')
    return conn


def snapshot(row):
    return {k: base64.b64encode(v).decode() if isinstance(v, bytes) else v for k, v in row.items()}


def message_by_guid(source, guid, chat_id):
    # Reaction targets carry a part prefix (p:0/GUID). Only strip that documented shape.
    guid = re.sub(r'^[pb]:\d+/', '', guid)
    row = source.execute('''SELECT m.* FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID
                           WHERE m.guid=? AND j.chat_id=?''', (guid, chat_id)).fetchone()
    return dict(row) if row else None


def contact_names():
    # Optional read-only name lookup. Never equate two people merely by their name.
    result = {}
    root = Path.home() / 'Library/Application Support/AddressBook'
    for path in root.glob('**/AddressBook-v*.abcddb'):
        try:
            with readonly(path) as db:
                for table, value in [('ZABCDPHONENUMBER', 'ZFULLNUMBER'), ('ZABCDEMAILADDRESS', 'ZADDRESS')]:
                    for row in db.execute(f'SELECT r.ZFIRSTNAME,r.ZLASTNAME,h.{value} FROM ZABCDRECORD r JOIN {table} h ON h.ZOWNER=r.Z_PK'):
                        name = ' '.join(x for x in row[:2] if x)
                        if name and row[2]:
                            result[normalize_handle(row[2])] = name
        except sqlite3.Error:
            continue
    return result


def contact_cards():
    """Structured fields for source participants only. Notes are never exported."""
    found={}
    for path in (Path.home()/'Library/Application Support/AddressBook').glob('**/AddressBook-v*.abcddb'):
        try:
            with readonly(path) as db:
                for row in db.execute('SELECT Z_PK,ZFIRSTNAME,ZLASTNAME,ZORGANIZATION,ZJOBTITLE,ZBIRTHDAY,ZMODIFICATIONDATE FROM ZABCDRECORD'):
                    pk,first,last,org,job,birthday,modified=row
                    fields=[];handles=[]
                    def add(label,value):
                        if value and not confidential(str(value)):
                            fields.append({'label':label,'value':str(value)[:2000]})
                    add('Name',' '.join(x for x in (first,last) if x));add('Organization',org);add('Job title',job)
                    for r in db.execute('SELECT ZFULLNUMBER,ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER=?',(pk,)):
                        if r[0]:handles.append(r[0]);add('Phone',r[0])
                    for r in db.execute('SELECT ZADDRESS,ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER=?',(pk,)):
                        if r[0]:handles.append(r[0]);add('Email',r[0])
                    for r in db.execute('SELECT ZSTREET,ZCITY,ZSTATE,ZZIPCODE,ZCOUNTRYNAME FROM ZABCDPOSTALADDRESS WHERE ZOWNER=?',(pk,)):
                        add('Address',', '.join(str(x) for x in r if x))
                    for r in db.execute('SELECT ZURL FROM ZABCDURLADDRESS WHERE ZOWNER=?',(pk,)):add('Website',r[0])
                    if birthday:
                        try:add('Birthday',datetime.fromtimestamp(float(birthday)+APPLE_EPOCH,timezone.utc).strftime('%B %d'))
                        except (ValueError,OverflowError):pass
                    card={'fields':fields[:40],'modifiedAt':apple_date(modified or 0)}
                    if len(json.dumps(card).encode())>16000:continue
                    for handle in handles:found.setdefault(normalize_handle(handle),[]).append(card)
        except sqlite3.Error:continue
    # Ambiguous contact identities stay unresolved. Do not merge cards by name.
    return {handle:cards[0] for handle,cards in found.items() if len(cards)==1}


def normalize_handle(handle):
    if '@' in handle:
        return handle.lower()
    digits = re.sub(r'\D', '', handle)
    return digits[1:] if len(digits) == 11 and digits.startswith('1') else digits


def capture_payload(source, row, chat, account, names, manual_tags=None):
    text, decoded = body_text(row)
    if not decoded:
        return None, 'unsupported-body'
    try:
        tags = validate_tags(manual_tags if manual_tags is not None else tags_in(text))
    except ValueError:
        return None, 'invalid-tags'
    reaction = row.get('associated_message_type') or 0
    emoji = row.get('associated_message_emoji') or ''
    is_reaction = bool(reaction)
    gesture = emoji if is_reaction else text.strip()
    if is_reaction and not (2000 <= reaction < 3000 and emoji in (SAVE_EMOJI, PIN_EMOJI)):
        return None, None
    if not tags and gesture not in (SAVE_EMOJI, PIN_EMOJI):
        return None, None
    # Native replies have explicit linkage; never infer the preceding message.
    parent_guid = None if manual_tags is not None else (row.get('associated_message_guid') if is_reaction else (row.get('reply_to_guid') or row.get('thread_originator_guid')))
    original = row
    if parent_guid:
        original = message_by_guid(source, parent_guid, chat['ROWID'])
        if not original:
            return None, 'missing-reply-target'
    elif gesture in (SAVE_EMOJI, PIN_EMOJI):
        return None, 'emoji-without-reply-target'
    original_text, decoded = body_text(original)
    if not decoded:
        return None, 'unsupported-source-body'
    if not original_text.strip():
        return None, 'source-has-no-text'
    if confidential(original_text) or confidential(text):
        return None, 'local-only-confidential'
    if len(original_text)>256000 or len(text)>256000 or any(len(tag)>256 for tag in tags):
        return None, 'capture-exceeds-server-limit'
    handles = [r[0] for r in source.execute('SELECT h.id FROM handle h JOIN chat_handle_join j ON h.ROWID=j.handle_id WHERE j.chat_id=?', (chat['ROWID'],))]
    title = chat.get('display_name') or ', '.join(names.get(normalize_handle(h), h) for h in handles) or chat.get('chat_identifier') or 'iMessage conversation'
    return {
        'channel': 'imessage', 'sourceAccount': account,
        'sourceThreadId': chat['guid'], 'threadTitle': title[:200], 'participants': handles[:100],
        'sourceMessageId': original['guid'], 'triggerMessageId': row['guid'],
        'text': original_text, 'triggerText': text,
        'sourceAt': apple_date(original['date']), 'capturedAt': apple_date(row['date']),
        'tags': tags[:50], 'pinned': gesture == PIN_EMOJI,
        'destination': 'contact' if any(t in ('address', 'contact') for t in tags) else ('note' if 'remember' in tags else 'stream'),
        'captureMethod': 'manual' if manual_tags is not None else ('reaction' if is_reaction else 'reply' if parent_guid else 'inline'),
    }, None


def event_id(account, chat, guid):
    return hashlib.sha256(json.dumps([account, chat, guid], separators=(',', ':')).encode()).hexdigest()


def archive(args):
    with readonly(args.messages) as source, private_db(args.state) as out:
        names = contact_names()
        cards = contact_cards()
        # Per-machine checkpoint; message GUIDs, not ROWIDs, dedupe across machines.
        checkpoint_key = str(Path(args.messages).expanduser().resolve()) + ':' + args.account + ':' + os.uname().nodename
        prior = out.execute('SELECT rowid FROM checkpoint WHERE source=?', (checkpoint_key,)).fetchone()
        after = 0 if args.full else (prior[0] if prior else 0)
        high = source.execute('SELECT coalesce(max(ROWID),0) FROM message').fetchone()[0]
        rows = source.execute('SELECT ROWID AS local_rowid,* FROM message WHERE is_from_me=1 AND ROWID>? AND ROWID<=? ORDER BY ROWID', (after, high))
        scanned = saved = pending = 0
        for raw in rows:
            row = dict(raw)
            scanned += 1
            chats = source.execute('SELECT c.ROWID AS ROWID,c.* FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID WHERE j.message_id=?', (row['local_rowid'],)).fetchall()
            for chat in chats:
                key = event_id(args.account, chat['guid'], row['guid'])
                payload, reason = capture_payload(source, row, dict(chat), args.account, names)
                if payload:
                    if len(payload['participants'])==1:
                        card=cards.get(normalize_handle(payload['participants'][0]))
                        if card:payload['contactDetails']=card
                    try:
                        validate_capture(payload)
                    except ValueError:
                        out.execute('INSERT OR REPLACE INTO review VALUES (?,?,?)', (key, 'invalid-capture', json.dumps({'messageGuid':row['guid'],'chatGuid':chat['guid']})))
                        pending += 1
                        continue
                    prior_payload=out.execute('SELECT payload,uploaded FROM outbox WHERE id=?',(key,)).fetchone()
                    serialized=json.dumps(payload,ensure_ascii=False)
                    if not prior_payload:
                        out.execute('INSERT INTO outbox(id,payload) VALUES (?,?)',(key,serialized));saved+=1
                    elif prior_payload[0]!=serialized:
                        out.execute('UPDATE outbox SET payload=?,uploaded=0 WHERE id=?',(serialized,key))
                    if not prior_payload or prior_payload[0]!=serialized or prior_payload[1]!=-1:
                        out.execute('DELETE FROM review WHERE id=?', (key,))
                elif reason:
                    # Review metadata points back to the canonical local message.
                    # Do not create an extra export of confidential/unknown values.
                    out.execute('INSERT OR REPLACE INTO review VALUES (?,?,?)', (key, reason, json.dumps({'messageGuid':row['guid'],'chatGuid':chat['guid']})))
                    pending += 1
            if scanned % 1000 == 0:
                out.commit()
        out.execute('INSERT OR REPLACE INTO checkpoint VALUES (?,?)', (checkpoint_key, high))
    return {'scanned': scanned, 'newCaptures': saved, 'reviewCandidates': pending, 'throughRow': high}


def config(args):
    path = Path(args.config).expanduser()
    if path.stat().st_mode & 0o077:
        raise ValueError('Connector config must be private (chmod 600).')
    value = json.loads(path.read_text())
    if not value['url'].startswith('https://'):
        raise ValueError('The server URL must use HTTPS.')
    return value


def api_call(cfg, path, body=None, method=None):
    request = urllib.request.Request(cfg['url'].rstrip('/')+'/api/captures'+path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization':'Bearer '+cfg['token'], 'Content-Type':'application/json'}, method=method)
    # urllib sends no redirect with credentials: refuse redirects for this dedicated client.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        return json.load(response)


def sync(args):
    cfg = config(args)
    sent = 0
    with private_db(args.state) as out:
        def quarantine(key, reason):
            out.execute('UPDATE outbox SET uploaded=-1 WHERE id=?', (key,))
            out.execute('INSERT OR REPLACE INTO review VALUES (?,?,?)', (key, reason, json.dumps({'outboxId':key})))
            out.commit()

        def upload(batch):
            nonlocal sent
            body = {'captures':[json.loads(r[1]) for r in batch]}
            if len(json.dumps(body).encode()) > 1900000:
                if len(batch) == 1:
                    quarantine(batch[0][0], 'capture-exceeds-upload-limit')
                    return
                middle = len(batch) // 2
                upload(batch[:middle])
                upload(batch[middle:])
                return
            try:
                response = api_call(cfg, '/ingest', body)
            except urllib.error.HTTPError as error:
                if error.code not in (400, 413, 422):
                    raise
                if len(batch) == 1:
                    quarantine(batch[0][0], 'server-rejected-' + str(error.code))
                    return
                middle = len(batch) // 2
                upload(batch[:middle])
                upload(batch[middle:])
                return
            if response.get('accepted') != len(batch):
                raise ValueError('Server did not acknowledge the whole batch; checkpoint retained.')
            out.executemany('UPDATE outbox SET uploaded=1 WHERE id=?', [(r[0],) for r in batch])
            out.commit()
            sent += len(batch)

        while True:
            batch = out.execute('SELECT id,payload FROM outbox WHERE uploaded=0 ORDER BY rowid LIMIT 25').fetchall()
            if not batch:
                break
            safe=[]
            for key,payload in batch:
                try:
                    value=json.loads(payload)
                    validate_capture(value)
                except (ValueError, TypeError):
                    quarantine(key, 'invalid-capture')
                    continue
                if confidential(value['text']) or confidential(value['triggerText']):
                    out.execute('INSERT OR REPLACE INTO review VALUES (?,?,?)',(key,'local-only-confidential',json.dumps({'messageGuid':value['sourceMessageId'],'chatGuid':value['sourceThreadId']})))
                    out.execute('DELETE FROM outbox WHERE id=?',(key,))
                else:safe.append((key,payload))
            out.commit()
            if safe:
                upload(safe)
    return {'uploaded': sent}


def save(args):
    tags = validate_tags(args.tag)
    with readonly(args.messages) as source, private_db(args.state) as out:
        row = source.execute('SELECT ROWID AS local_rowid,* FROM message WHERE guid=?', (args.guid,)).fetchone()
        if not row:
            raise ValueError('Message GUID not found.')
        chats = source.execute('SELECT c.ROWID AS ROWID,c.* FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID WHERE j.message_id=?', (row['local_rowid'],)).fetchall()
        if len(chats) != 1:
            raise ValueError('Message must resolve to one source conversation.')
        payload, reason = capture_payload(source, dict(row), dict(chats[0]), args.account, contact_names(), tags)
        if not payload:
            raise ValueError(reason or 'At least one tag is required.')
        # Manual save captures the selected message itself, not its reply parent.
        text, decoded = body_text(dict(row))
        if not decoded or not text.strip():
            raise ValueError('Selected message has no decodable text.')
        payload.update(text=text, sourceMessageId=row['guid'], sourceAt=apple_date(row['date']))
        if len(payload['participants'])==1:
            card=contact_cards().get(normalize_handle(payload['participants'][0]))
            if card:payload['contactDetails']=card
        key = event_id(args.account, chats[0]['guid'], row['guid']+':manual:'+','.join(sorted(tags)))
        payload['triggerMessageId'] = row['guid']+':manual:'+','.join(sorted(tags))
        validate_capture(payload)
        out.execute('INSERT OR IGNORE INTO outbox(id,payload) VALUES (?,?)', (key,json.dumps(payload,ensure_ascii=False)))
        return {'saved':out.execute('SELECT changes()').fetchone()[0]}


def status(args):
    with private_db(args.state) as out:
        return {'captures':out.execute('SELECT count(*) FROM outbox').fetchone()[0],
                'pendingUpload':out.execute('SELECT count(*) FROM outbox WHERE uploaded=0').fetchone()[0],
                'review':dict(out.execute('SELECT reason,count(*) FROM review GROUP BY reason').fetchall())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--messages', default=str(Path.home()/'Library/Messages/chat.db'))
    parser.add_argument('--state', default=str(Path.home()/'Library/Application Support/OpenChat/companion.sqlite3'))
    parser.add_argument('--config', default=str(Path.home()/'.config/openchat/companion.json'))
    parser.add_argument('--account', default='personal-imessage', help='Same namespace on Macs with the same Messages account; distinct for other accounts.')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    sub.add_parser('sync')
    archive_parser = sub.add_parser('archive'); archive_parser.add_argument('--full', action='store_true')
    watch = sub.add_parser('watch'); watch.add_argument('--interval',type=int,default=30);watch.add_argument('--archive-only',action='store_true')
    one = sub.add_parser('save');one.add_argument('--guid',required=True);one.add_argument('--tag',action='append',required=True)
    send = sub.add_parser('send', help='Explicit send via installed imsg; never used by capture.')
    send.add_argument('--to',required=True);send.add_argument('--text',required=True)
    args = parser.parse_args()
    try:
        if args.command == 'watch':
            lock_path=Path(args.state).expanduser().with_suffix('.watch.lock')
            lock_path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            watch_lock=open(lock_path,'w')
            try:fcntl.flock(watch_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise ValueError('This archive already has an active watcher.')
            args.full = False
            last_full=0
            while True:
                try:
                    args.full=time.monotonic()-last_full>21600
                    result = archive(args)
                    if args.full:last_full=time.monotonic()
                    if not args.archive_only: result.update(sync(args))
                    print(json.dumps(result),flush=True)
                except Exception as error:
                    # Never log request bodies, tokens, or captured messages.
                    print(json.dumps({'error':type(error).__name__,'retrying':True}),file=sys.stderr,flush=True)
                time.sleep(max(10,args.interval))
        elif args.command == 'send':
            result = subprocess.run(['imsg','send','--to',args.to,'--text',args.text,'--json'],check=True,capture_output=True,text=True)
            print(result.stdout)
        else:
            print(json.dumps(globals()[args.command](args)))
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        print(json.dumps({'error':type(error).__name__,'detail':str(error) if isinstance(error,ValueError) else 'Operation failed; outbox retained.'}),file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
