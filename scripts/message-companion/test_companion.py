import argparse
import json
import sqlite3
import urllib.error
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import companion as app


class CaptureTests(unittest.TestCase):
    def setUp(self):
        cards=patch.object(app,"contact_cards",return_value={});cards.start();self.addCleanup(cards.stop)
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
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

    def test_manual_tags_validate_before_enqueue_and_normalize_routing(self):
        self.message('source','An ordinary message',False)
        self.args.guid='source'
        for tags in (['two words'], ['#address'], ['-bad'], ['a'*257], ['x']*51, ['😀']):
            self.args.tag=tags
            with self.assertRaises(ValueError):app.save(self.args)
        self.assertFalse(self.state.exists())
        self.args.tag=['ＡＤＤＲＥＳＳ', 'Cafe\u0301', 'Straße', 'a\u0301b']
        with patch.object(app,'contact_names',return_value={}):app.save(self.args)
        self.assertEqual(self.rows()[0]['tags'],['address','café','straße','áb'])
        self.assertEqual(self.rows()[0]['destination'],'contact')

    def test_archive_validates_metadata_before_enqueue(self):
        self.message('source','An ordinary message #tag')
        self.args.account='a'*201
        self.archive()
        self.assertEqual(self.rows(),[])
        self.assertEqual(app.status(self.args)['review'],{'invalid-capture':1})

    def prepare_uploads(self, count=3):
        for i in range(count):self.message(str(i),'Ordinary message #tag')
        self.archive()
        cfg=patch.object(app,'config',return_value={'url':'https://example.test','token':'dummy'})
        cfg.start();self.addCleanup(cfg.stop)

    def upload_states(self):
        with sqlite3.connect(self.state) as c:
            return [r[0] for r in c.execute('SELECT uploaded FROM outbox ORDER BY rowid')]

    def test_invalid_legacy_rows_are_quarantined_without_blocking_later_batches(self):
        self.prepare_uploads(27)
        with sqlite3.connect(self.state) as c:
            key,payload=c.execute('SELECT id,payload FROM outbox ORDER BY rowid LIMIT 1').fetchone()
            value=json.loads(payload);value['tags']=['two words']
            c.execute('UPDATE outbox SET payload=? WHERE id=?',(json.dumps(value),key))
        with patch.object(app,'api_call',side_effect=lambda cfg,path,body:{'accepted':len(body['captures'])}) as call:
            self.assertEqual(app.sync(self.args),{'uploaded':26})
            self.assertEqual(app.sync(self.args),{'uploaded':0})
            self.assertEqual(call.call_count,2)
        self.assertEqual(self.upload_states(),[-1]+[1]*26)
        self.assertEqual(app.status(self.args)['review'],{'invalid-capture':1})
        self.assertEqual(self.rows()[0]['tags'],['two words'])

    def test_server_permanent_rejection_is_isolated_and_retained(self):
        self.prepare_uploads()
        def upload(cfg,path,body):
            if any(c['sourceMessageId']=='1' for c in body['captures']):
                raise urllib.error.HTTPError('https://example.test',400,'Invalid capture',{},None)
            return {'accepted':len(body['captures'])}
        with patch.object(app,'api_call',side_effect=upload) as call:
            self.assertEqual(app.sync(self.args),{'uploaded':2})
            count=call.call_count
            self.assertEqual(app.sync(self.args),{'uploaded':0})
            self.assertEqual(call.call_count,count)
        self.assertEqual(self.upload_states(),[1,-1,1])
        self.assertEqual(app.status(self.args)['review'],{'server-rejected-400':1})
        self.assertEqual(len(self.rows()),3)
        self.archive()
        self.assertEqual(app.status(self.args)['review'],{'server-rejected-400':1})
        self.assertEqual(self.upload_states(),[1,-1,1])

    def test_transient_and_auth_failures_remain_pending_for_retry(self):
        self.prepare_uploads()
        for code in (401,403,429,500,503):
            with patch.object(app,'api_call',side_effect=urllib.error.HTTPError('https://example.test',code,'Retry',{},None)):
                with self.assertRaises(urllib.error.HTTPError):app.sync(self.args)
            self.assertEqual(self.upload_states(),[0,0,0])
            self.assertEqual(app.status(self.args)['review'],{})
        with patch.object(app,'api_call',return_value={'accepted':3}):
            self.assertEqual(app.sync(self.args),{'uploaded':3})

    def test_partial_progress_survives_transient_failure_during_isolation(self):
        self.prepare_uploads()
        def upload(cfg,path,body):
            ids=[c['sourceMessageId'] for c in body['captures']]
            if '1' in ids:raise urllib.error.HTTPError('https://example.test',400,'Invalid',{},None)
            if '2' in ids:raise urllib.error.HTTPError('https://example.test',503,'Retry',{},None)
            return {'accepted':len(ids)}
        with patch.object(app,'api_call',side_effect=upload):
            with self.assertRaises(urllib.error.HTTPError):app.sync(self.args)
        self.assertEqual(self.upload_states(),[1,-1,0])
        with patch.object(app,'api_call',return_value={'accepted':1}):
            self.assertEqual(app.sync(self.args),{'uploaded':1})

    def test_incomplete_acknowledgement_remains_pending(self):
        self.prepare_uploads()
        with patch.object(app,'api_call',return_value={'accepted':1}):
            with self.assertRaises(ValueError):app.sync(self.args)
        self.assertEqual(self.upload_states(),[0,0,0])

    def test_explicit_confidential_manual_tags_never_enqueue(self):
        self.message('source','Ordinary words',False)
        self.args.guid='source'
        for tag in ('confidential','CONFIDENTIAL','ＣＯＮＦＩＤＥＮＴＩＡＬ'):
            self.args.tag=[tag]
            with patch.object(app,'contact_names',return_value={}):
                with self.assertRaisesRegex(ValueError,'local-only-confidential'):
                    app.save(self.args)
        self.assertEqual(self.rows(),[])

    def test_existing_confidential_tag_is_removed_without_upload(self):
        self.prepare_uploads(1)
        with sqlite3.connect(self.state) as c:
            key,payload=c.execute('SELECT id,payload FROM outbox').fetchone()
            value=json.loads(payload);value['tags']=['ＣＯＮＦＩＤＥＮＴＩＡＬ']
            c.execute('UPDATE outbox SET payload=? WHERE id=?',(json.dumps(value),key))
        with patch.object(app,'api_call') as call:
            self.assertEqual(app.sync(self.args),{'uploaded':0})
            call.assert_not_called()
        self.assertEqual(self.rows(),[])
        self.assertEqual(app.status(self.args)['review'],{'local-only-confidential':1})

    def test_acknowledgement_does_not_consume_concurrent_payload_update(self):
        self.prepare_uploads(1)
        sent=[]
        def upload(cfg,path,body):
            sent.append(body['captures'][0])
            if len(sent)>1:
                raise urllib.error.HTTPError('https://example.test',503,'Retry',{},None)
            with sqlite3.connect(self.state) as c:
                key,payload=c.execute('SELECT id,payload FROM outbox').fetchone()
                updated=json.loads(payload)
                updated['contactDetails']={'modifiedAt':'2026-10-09T00:00:00Z','fields':[{'label':'City','value':'Example City'}]}
                c.execute('UPDATE outbox SET payload=?,uploaded=0 WHERE id=?',(json.dumps(updated),key))
            return {'accepted':1}
        with patch.object(app,'api_call',side_effect=upload):
            with self.assertRaises(urllib.error.HTTPError):app.sync(self.args)
        self.assertEqual(self.upload_states(),[0])
        self.assertNotIn('contactDetails',sent[0])
        self.assertEqual(sent[1]['contactDetails']['fields'][0]['value'],'Example City')
        with patch.object(app,'api_call',return_value={'accepted':1}) as call:
            self.assertEqual(app.sync(self.args),{'uploaded':1})
            self.assertEqual(call.call_args.args[2]['captures'][0],sent[1])
        self.assertEqual(self.upload_states(),[1])

    def test_rejection_does_not_quarantine_concurrently_corrected_payload(self):
        self.prepare_uploads(1)
        sent=[]
        def upload(cfg,path,body):
            sent.append(body['captures'][0])
            if len(sent)==1:
                with sqlite3.connect(self.state) as c:
                    key,payload=c.execute('SELECT id,payload FROM outbox').fetchone()
                    value=json.loads(payload);value['text']='Corrected ordinary text'
                    c.execute('UPDATE outbox SET payload=?,uploaded=0 WHERE id=?',(json.dumps(value),key))
                raise urllib.error.HTTPError('https://example.test',400,'Invalid',{},None)
            return {'accepted':1}
        with patch.object(app,'api_call',side_effect=upload):
            self.assertEqual(app.sync(self.args),{'uploaded':1})
        self.assertEqual(self.upload_states(),[1])
        self.assertEqual(app.status(self.args)['review'],{})
        self.assertEqual(sent[1]['text'],'Corrected ordinary text')

    def test_contact_snapshots_are_scrubbed_before_archive_and_manual_enqueue(self):
        card={'modifiedAt':'2026-10-09T00:00:00Z','fields':[
            {'label':'confidential','value':'dummy-private'},
            {'label':'City','value':'Example City'},
        ]}
        self.message('source','Ordinary words #tag')
        with patch.object(app,'contact_cards',return_value={'dad@example.test':card}):
            self.archive()
            self.args.guid='source';self.args.tag=['address']
            with patch.object(app,'contact_names',return_value={}):app.save(self.args)
        self.assertEqual(len(self.rows()),2)
        for row in self.rows():
            self.assertEqual(row['contactDetails']['fields'],[{'label':'City','value':'Example City'}])
        self.assertEqual(len(card['fields']),2)

    def test_staged_contact_fields_are_scrubbed_before_upload_and_retry(self):
        self.prepare_uploads(1)
        safe={'label':'Address · Home','value':'Apartment 3'}
        card={'modifiedAt':'2026-10-09T00:00:00Z','fields':[
            safe,{'label':'ＣＯＮＦＩＤＥＮＴＩＡＬ','value':'dummy-private'},
            {'label':'Passport','value':'dummy-id'},{'label':'Bank account','value':'dummy-id'},
            {'label':'Other','value':'123-45-6789'},
        ]}
        with sqlite3.connect(self.state) as c:
            key,payload=c.execute('SELECT id,payload FROM outbox').fetchone()
            value=json.loads(payload);value['contactDetails']=card
            c.execute('UPDATE outbox SET payload=? WHERE id=?',(json.dumps(value),key))
        def unavailable(cfg,path,body):
            self.assertEqual(body['captures'][0]['contactDetails']['fields'],[safe])
            raise urllib.error.HTTPError('https://example.test',503,'Retry',{},None)
        with patch.object(app,'api_call',side_effect=unavailable):
            with self.assertRaises(urllib.error.HTTPError):app.sync(self.args)
        self.assertEqual(self.rows()[0]['contactDetails']['fields'],[safe])
        self.assertEqual(self.upload_states(),[0])
        with patch.object(app,'api_call',return_value={'accepted':1}) as call:
            self.assertEqual(app.sync(self.args),{'uploaded':1})
            self.assertEqual(call.call_args.args[2]['captures'][0]['contactDetails']['fields'],[safe])
        self.assertEqual(self.upload_states(),[1])


class ContactSnapshotTests(unittest.TestCase):
    def test_reads_source_labels_without_exporting_confidential_fields_or_mutating_contacts(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            root=Path(temp)
            folder=root/'Library/Application Support/AddressBook';folder.mkdir(parents=True)
            path=folder/'AddressBook-v22.abcddb'
            db=sqlite3.connect(path)
            try:
                db.executescript("""
                    CREATE TABLE ZABCDRECORD (Z_PK INTEGER,ZFIRSTNAME TEXT,ZLASTNAME TEXT,ZORGANIZATION TEXT,ZJOBTITLE TEXT,ZBIRTHDAY REAL,ZMODIFICATIONDATE REAL);
                    CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER,ZFULLNUMBER TEXT,ZLABEL TEXT);
                    CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER,ZADDRESS TEXT,ZLABEL TEXT);
                    CREATE TABLE ZABCDPOSTALADDRESS (ZOWNER INTEGER,ZSTREET TEXT,ZCITY TEXT,ZSTATE TEXT,ZZIPCODE TEXT,ZCOUNTRYNAME TEXT,ZLABEL TEXT);
                    CREATE TABLE ZABCDURLADDRESS (ZOWNER INTEGER,ZURL TEXT,ZLABEL TEXT);
                    INSERT INTO ZABCDRECORD VALUES (1,'Example','Person','Example org','Designer',NULL,1000);
                    INSERT INTO ZABCDEMAILADDRESS VALUES (1,'person@example.test','_$!<Home>!$_');
                    INSERT INTO ZABCDEMAILADDRESS VALUES (1,'private@example.test','confidential');
                    INSERT INTO ZABCDPHONENUMBER VALUES (1,'555-0100','Mobile');
                    INSERT INTO ZABCDPHONENUMBER VALUES (1,'dummy-phone','ＣＯＮＦＩＤＥＮＴＩＡＬ');
                    INSERT INTO ZABCDPHONENUMBER VALUES (1,'123-45-6789','Other');
                    INSERT INTO ZABCDPOSTALADDRESS VALUES (1,'Apartment 3',NULL,NULL,NULL,NULL,'_$!<Home>!$_');
                    INSERT INTO ZABCDPOSTALADDRESS VALUES (1,'dummy-private',NULL,NULL,NULL,NULL,'Confidential');
                    INSERT INTO ZABCDURLADDRESS VALUES (1,'https://example.test','Personal');
                    INSERT INTO ZABCDURLADDRESS VALUES (1,'https://private.example.test','confidential');
                """)
                db.commit()
            finally:db.close()
            original=path.read_bytes()
            with patch.object(Path,'home',return_value=root):cards=app.contact_cards()
            self.assertEqual(set(cards),{'person@example.test','5550100'})
            self.assertEqual(cards['person@example.test']['fields'],[
                {'label':'Name','value':'Example Person'},
                {'label':'Organization','value':'Example org'},
                {'label':'Job title','value':'Designer'},
                {'label':'Phone · Mobile','value':'555-0100'},
                {'label':'Email · Home','value':'person@example.test'},
                {'label':'Address · Home','value':'Apartment 3'},
                {'label':'Website · Personal','value':'https://example.test'},
            ])
            self.assertEqual(path.read_bytes(),original)


if __name__=='__main__': unittest.main()
