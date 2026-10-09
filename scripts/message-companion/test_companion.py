import argparse
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import companion as app


class CaptureTests(unittest.TestCase):
    def setUp(self):
        cards=patch.object(app,"contact_cards",return_value={});cards.start();self.addCleanup(cards.stop)
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.messages=self.root/'messages.sqlite3'
        self.state=self.root/'archive.sqlite3'
        with sqlite3.connect(self.messages) as c:
            c.executescript('''CREATE TABLE message (guid TEXT,text TEXT,attributedBody BLOB,date INTEGER,is_from_me INTEGER,reply_to_guid TEXT,thread_originator_guid TEXT,associated_message_type INTEGER,associated_message_guid TEXT,associated_message_emoji TEXT);
            CREATE TABLE chat (guid TEXT,display_name TEXT,chat_identifier TEXT);
            CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
            CREATE TABLE handle(id TEXT);
            CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);
            INSERT INTO chat VALUES ('chat-roger','Dad','dad@example.test');
            INSERT INTO handle VALUES ('dad@example.test'); INSERT INTO chat_handle_join VALUES (1,1);''')
        self.args=argparse.Namespace(messages=str(self.messages),state=str(self.state),account='test',full=True)
    def tearDown(self): self.temp.cleanup()
    def message(self,guid,text,own=True,parent=None,blob=None,emoji=None):
        with sqlite3.connect(self.messages) as c:
            cur=c.execute('INSERT INTO message VALUES (?,?,?,1000000000000000000,?,?,NULL,?,?,?)',(guid,text,blob,int(own),parent,2006 if emoji else 0,'p:0/'+parent if emoji else None,emoji))
            c.execute('INSERT INTO chat_message_join VALUES (1,?)',(cur.lastrowid,))
    def archive(self):
        with patch.object(app,'contact_names',return_value={}): return app.archive(self.args)
    def rows(self):
        with sqlite3.connect(self.state) as c:return [json.loads(r[0]) for r in c.execute('SELECT payload FROM outbox')]
    def test_authored_tags_capture_parent_without_importing_other_peoples_tags(self):
        self.message('parent','https://example.test/article',False)
        self.message('reply','#longevity #read-later',True,'parent')
        self.message('foreign','#private-other',False)
        self.assertEqual(self.archive()['newCaptures'],1)
        row=self.rows()[0]
        self.assertEqual(row['text'],'https://example.test/article')
        self.assertEqual(row['sourceMessageId'],'parent')
        self.assertEqual(row['tags'],['longevity','read-later'])
        self.assertEqual(self.archive()['newCaptures'],0)
    def test_inline_and_url_anchors(self):
        self.message('inline','Look at https://example.test/#not-a-tag #Longévité #tag_2')
        self.message('url-only','https://example.test/#not-a-tag')
        self.archive()
        self.assertEqual(len(self.rows()),1)
        self.assertEqual(self.rows()[0]['tags'],['longévité','tag_2'])
    def test_emoji_save_and_pin_remain_distinct(self):
        self.message('a','First',False);self.message('b','Second',False)
        self.message('save','🔖',parent='a');self.message('pin','📌',parent='b')
        self.message('unlinked','📌')
        self.archive();rows=self.rows()
        self.assertFalse(rows[0]['pinned']);self.assertTrue(rows[1]['pinned'])
        self.assertEqual(app.status(self.args)['review'],{'emoji-without-reply-target':1})
    def test_missing_parent_is_preserved_and_resolves_on_replay(self):
        self.message('reply','#longevity',parent='absent');self.archive()
        self.assertEqual(self.rows(),[])
        self.message('absent','Original words',False);self.archive()
        self.assertEqual(self.rows()[0]['text'],'Original words')
        self.assertEqual(app.status(self.args)['review'],{})
    def test_typedstream_unicode_and_unknown_body(self):
        text='A thought #café';encoded=text.encode()
        blob=b'prefixNSString\x01\x95\x84\x01+'+bytes([len(encoded)])+encoded+b'\x86'
        self.message('typed',None,blob=blob);self.message('unknown',None,blob=b'unknown')
        self.archive();self.assertEqual(self.rows()[0]['text'],text)
        self.assertEqual(app.status(self.args)['review'],{'unsupported-body':1})
    def test_reaction_prefix_and_manual_save(self):
        self.message('source','Address provided by someone',False)
        self.message('reaction',None,parent='source',emoji='📌')
        self.archive();self.assertTrue(self.rows()[0]['pinned'])
        self.args.guid='source';self.args.tag=['address']
        with patch.object(app,'contact_names',return_value={}):app.save(self.args)
        self.assertEqual(self.rows()[1]['destination'],'contact')
        self.assertEqual(self.rows()[1]['sourceMessageId'],'source')
    def test_incremental_checkpoint_and_private_permissions(self):
        self.message('one','#first');self.archive()
        self.args.full=False
        self.assertEqual(self.archive()['scanned'],0)
        self.message('two','#second');self.assertEqual(self.archive()['newCaptures'],1)
        self.assertEqual(self.state.stat().st_mode & 0o777,0o600)
    def test_no_cross_thread_reply_capture(self):
        self.message('reply','#longevity',parent='elsewhere')
        with sqlite3.connect(self.messages) as c:
            c.execute("INSERT INTO message(guid,text,is_from_me,date) VALUES ('elsewhere','Other thread',0,1000)")
        self.archive();self.assertEqual(self.rows(),[])
    def test_confidential_fields_stay_in_canonical_local_source(self):
        self.message('sensitive','Example SSN: 123-45-6789 #remember')
        self.message('ordinary','42 Example Lane #address')
        self.archive()
        self.assertEqual(len(self.rows()),1)
        self.assertEqual(app.status(self.args)['review'],{'local-only-confidential':1})
        with sqlite3.connect(self.state) as c:
            review=json.loads(c.execute('SELECT snapshot FROM review').fetchone()[0])
        self.assertEqual(review,{'messageGuid':'sensitive','chatGuid':'chat-roger'})


if __name__=='__main__': unittest.main()
