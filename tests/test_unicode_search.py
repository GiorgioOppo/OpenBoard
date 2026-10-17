"""Unicode caseless/canonical search, original excerpts, ACLs and vendor checks."""
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlencode

import test_api
import test_auth

ROOT = Path(__file__).resolve().parents[1]


class UnicodeSearch(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api
    create_board = test_api.OpenBoardAPI.create_board
    create_card = test_api.OpenBoardAPI.create_card
    board = test_api.OpenBoardAPI.board

    def search(self, term, content=False, **query):
        return self.api('GET', '/api/search' + ('/content' if content else '') + '?' + urlencode({'q':term, **query}))

    def test_full_casefold_canonical_equivalence_and_cjk_across_card_fields(self):
        board=self.create_board();column=board['columns'][0]['id'];ids=[]
        text='Straße CAFÉ Σίσυφος Привет 𐐀 中文 日本語'
        ids.append(self.create_card(column,text))
        ids.append(self.create_card(column,'Description match',description=text))
        ids.append(self.create_card(column,'Display match',assignee=text))
        for query in ('STRASSE','Cafe\u0301','ΣΊΣΥΦΟΣ','ПРИВЕТ','𐐨','中文','日本語'):
            with self.subTest(query=query):
                self.assertEqual({item['id'] for item in self.search(query)['cards']},set(ids))
                self.assertEqual({item['id'] for item in self.search(query,content=True)['items']},set(ids))
        self.assertNotIn('items',self.search('STRASSE'))

    def test_no_accent_stripping_compatibility_transliteration_or_stemming(self):
        board=self.create_board();column=board['columns'][0]['id']
        variants=[('café','cafe'),('Ё','е'),('中文','zhongwen'),('Ａ','a'),('Ⓐ','a'),('ø','o'),('æ','ae'),('ı','I'),('running','runniŋ')]
        for text, query in variants:
            card=self.create_card(column,text)
            with self.subTest(text=text,query=query):
                self.assertNotIn(card,[item['id'] for item in self.search(query)['cards']])
                self.assertNotIn(card,[item['id'] for item in self.search(query,content=True)['items']])

    def test_original_snippet_offsets_after_expansion_and_canonical_composition(self):
        board=self.create_board();column=board['columns'][0]['id']
        prefix='ß'*180+'e\u0301'*100+'中'*70
        body=prefix+'Straße Cafe\u0301 🎉'+' z'*150
        card=self.create_card(column,'Excerpt',description=body)
        result=next(item for item in self.search('STRASSE',content=True)['items'] if item['id']==card)
        self.assertTrue(result['snippet'].startswith('中'*40+'Straße'))
        self.assertIn('Cafe\u0301',result['snippet']);self.assertNotIn('Café',result['snippet'])
        self.assertLessEqual(len(result['snippet']),240)
        self.assertIn(result['snippet'],body)
        result=next(item for item in self.search('CAFÉ',content=True)['items'] if item['id']==card)
        self.assertIn('Cafe\u0301',result['snippet']);self.assertIn(result['snippet'],body)
        long_cluster='x'*300+'a'+'\u0301'*1000+'\u0315 tail'
        card=self.create_card(column,'Long combining sequence',description=long_cluster)
        result=next(item for item in self.search('\u0315',content=True)['items'] if item['id']==card)
        self.assertIn('\u0315 tail',result['snippet']);self.assertLessEqual(len(result['snippet']),240)

    def test_unicode_pagination_keeps_live_filters_and_original_query_limits(self):
        board=self.create_board();column=board['columns'][0]['id']
        ids=[self.create_card(column,'Straße '+str(index)) for index in range(3)]
        hidden=self.create_card(column,'Straße hidden',archived=True)
        first=self.search('STRASSE',limit=1);self.assertEqual(first['cards'][0]['id'],ids[-1])
        second=self.search('straße',limit=1,before=first['next_cursor']);self.assertEqual(second['cards'][0]['id'],ids[-2])
        content=self.search('STRASSE',content=True,limit=1)
        self.assertEqual(content['next_cursor'],f'0:{ids[-1]}')
        self.assertEqual(self.search('straße',content=True,limit=1,cursor=content['next_cursor'])['items'][0]['id'],ids[-2])
        self.assertNotIn(hidden,[item['id'] for item in self.search('STRASSE',content=True)['items']])
        self.api('DELETE',f"/api/boards/{board['id']}")
        self.assertEqual(self.search('STRASSE')['cards'],[])
        self.assertEqual(self.search('STRASSE',content=True)['items'],[])
        other=self.create_board();match=self.create_card(other['columns'][0]['id'],'ß'*200)
        # Percent-encoded request targets retain the existing transport-size cap.
        self.assertIn(match,[item['id'] for item in self.search('ß'*160)['cards']])
        self.assertIn(match,[item['id'] for item in self.search('S'*200)['cards']])
        for path in ('/api/search','/api/search/content'):
            self.api('GET',path+'?'+urlencode({'q':'ß'*201}),expected=400)
            for malformed in ('%FF','%ED%A0%80','%00'):
                self.api('GET',path+'?q='+malformed,expected=400)

    def test_invalid_stored_utf8_fails_closed(self):
        board=self.create_board();card=self.create_card(board['columns'][0]['id'],'Synthetic invalid storage')
        with sqlite3.connect(self.db) as connection:
            connection.execute("UPDATE cards SET description=CAST(x'ff' AS TEXT) WHERE id=?",(card,))
        self.api('GET','/api/search?q=unmatched-synthetic-value',expected=503)
        self.api('GET','/api/search/content?q=unmatched-synthetic-value',expected=503)


class UnicodeSearchAuth(unittest.TestCase):
    setUp=test_auth.OpenBoardAuth.setUp
    stop=test_auth.OpenBoardAuth.stop
    read_log=test_auth.OpenBoardAuth.read_log
    request=test_auth.OpenBoardAuth.request
    api=test_auth.OpenBoardAuth.api
    session=test_auth.OpenBoardAuth.session
    add_user=test_auth.OpenBoardAuth.add_user
    login=test_auth.OpenBoardAuth.login
    sql=test_auth.OpenBoardAuth.sql

    def search(self, term='STRASSE', actor='admin', **query):
        result,_=self.api('GET','/api/search/content?'+urlencode({'q':term,**query}),actor=actor)
        return result

    def form_request(self):
        form,_=self.api('POST','/api/boards/1/intake/forms',{'name':'Straße form','description':'Cafe\u0301 form','column_id':1},expected=201)
        self.api('POST',f"/api/intake/forms/{form['id']}/fields",{'key':'details','name':'Details','type':'text'},expected=201)
        self.api('POST',f"/api/intake/forms/{form['id']}/publish",{})
        request,_=self.api('POST',f"/api/intake/forms/{form['id']}/requests",{'title':'Unicode request','answers':{'details':'Straße Cafe\u0301 Σίσυφος 中文 日本語'}},expected=201)
        self.api('POST',f"/api/intake/requests/{request['id']}/notes",{'body':'Straße Cafe\u0301 note'},expected=201)
        return form['id'],request['id']

    def test_comments_requests_answers_notes_and_forms_use_unicode_matching(self):
        self.api('PATCH','/api/cards/1',{'description':'Straße Cafe\u0301 card'})
        self.api('POST','/api/cards/1/comments',{'body':'Straße Cafe\u0301 comment'},expected=201)
        self.form_request()
        found=self.search()
        self.assertEqual({item['kind'] for item in found['items']},{'card','comment','request','request_note','form'})
        for item in found['items']:
            if item['kind']!='form':self.assertIn('Straße',item['snippet'])
        found=self.search('CAFÉ')
        self.assertEqual({item['kind'] for item in found['items']},{'card','comment','request','request_note','form'})
        for item in found['items']:self.assertIn('Cafe\u0301',item['snippet'])
        for query in ('ΣΊΣΥΦΟΣ','中文','日本語'):
            self.assertEqual([item['kind'] for item in self.search(query)['items']],['request'])

    def test_unicode_matches_do_not_bypass_acl_revocation_or_search_json_keys(self):
        observer=self.add_user('unicode-observer','observer');self.add_user('unicode-outsider')
        self.login('unicode-observer');self.login('unicode-outsider')
        self.api('POST','/api/boards/1/members',{'user_id':observer,'role':'observer'})
        self.api('POST','/api/cards/1/comments',{'body':'Straße secret comment'},expected=201)
        _,request=self.form_request()
        self.assertEqual(self.search(actor='unicode-outsider')['items'],[])
        first=self.search(actor='unicode-observer',limit=1)
        self.assertEqual(first['items'][0]['kind'],'comment')
        self.api('DELETE',f'/api/boards/1/members/{observer}')
        self.assertEqual(self.search(actor='unicode-observer',cursor=first['next_cursor'])['items'],[])
        self.sql("UPDATE intake_requests SET answers=json_object('Straße','unrelated value') WHERE id=?",(request,))
        self.assertEqual(self.search(kind='request')['items'],[])


class UnicodeVendor(unittest.TestCase):
    def test_pinned_sources_and_native_unicode_origin_corpus(self):
        checked=subprocess.run([sys.executable,str(ROOT/'vendor/utf8proc/check-vendor.py')],cwd=ROOT,capture_output=True,text=True,timeout=10)
        self.assertEqual(checked.returncode,0,checked.stderr)
        with tempfile.TemporaryDirectory(prefix='openboard-unicode-') as directory:
            binary=Path(directory)/'unicode-fixture'
            flags=['-D_POSIX_C_SOURCE=200809L','-O1','-g','-std=c11','-Wall','-Wextra','-Wpedantic']
            if 'sanitize' in str(test_api.BINARY):flags.append('-fsanitize=address,undefined')
            command=shlex.split(os.environ.get('CC','cc'))+flags+[str(ROOT/'tests/fixtures/unicode_search.c'),str(ROOT/'src/unicode.c'),str(ROOT/'src/utf8proc_vendor.c'),'-o',str(binary),'-lsqlite3']
            compiled=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=60)
            self.assertEqual(compiled.returncode,0,compiled.stderr)
            executed=subprocess.run([str(binary)],cwd=ROOT,capture_output=True,text=True,timeout=30)
            self.assertEqual(executed.returncode,0,executed.stdout+executed.stderr)
            self.assertIn('2692 changed Unicode scalar mappings',executed.stdout)


if __name__=='__main__':unittest.main()
