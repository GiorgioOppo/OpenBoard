"""Upgrade from a real 0.3 schema and full-instance recovery across 0.4 modules."""
import base64
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import unittest

import test_api


class Release04Recovery(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api
    create_board = test_api.OpenBoardAPI.create_board
    create_card = test_api.OpenBoardAPI.create_card

    def test_upgrade_real_v4_fixture_keeps_content_and_pre_upgrade_backup(self):
        self.stop_server()
        for suffix in ('', '-wal', '-shm'):
            Path(str(self.db)+suffix).unlink(missing_ok=True)
        fixture = (test_api.ROOT/'tests/fixtures/openboard_v4.sql').read_text(encoding='utf-8')
        with closing(sqlite3.connect(self.db)) as connection:
            connection.executescript(fixture)
        self.start_server()
        boards = self.api('GET','/api/boards')['boards']
        self.assertEqual([b['name'] for b in boards], ['Migrazione da OpenBoard 0.3'])
        card = self.api('GET','/api/cards/1')
        self.assertEqual(card['title'],'Dati da conservare')
        self.assertEqual(card['actual_minutes'],12)
        self.assertEqual(card['total_minutes'],12)
        self.assertEqual(card['logged_minutes'],0)
        self.assertEqual(card['custom_values'],{})
        self.assertEqual(card['milestone_key'],'')
        self.assertEqual(card['labels'],['design','sviluppo'])
        self.assertEqual(card['checklist'][0]['text'],'Non perdere questa voce')
        self.assertTrue(card['checklist'][0]['done'])
        comment = self.api('GET','/api/cards/1/comments')['comments'][0]
        self.assertEqual(comment['body'],'Commento precedente alla 0.4')
        attachment = self.api('GET','/api/attachments/1')
        self.assertEqual(base64.b64decode(attachment['data_base64']),b'legacy-content')
        self.assertEqual(self.api('GET','/api/boards/1/views')['views'][0]['name'],'Filtro storico')
        self.assertEqual(self.api('GET','/api/templates/cards')['templates'][0]['name'],'Modello storico')
        backup = Path(str(self.db)+'.pre-v4.bak')
        self.assertTrue(backup.is_file())
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0],4)
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(connection.execute('SELECT actual_minutes FROM cards WHERE id=1').fetchone()[0],12)
            self.assertIsNone(connection.execute("SELECT name FROM sqlite_master WHERE name='worklogs'").fetchone())
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0],7)
        self.stop_server();self.start_server()
        self.assertEqual(self.api('GET','/api/cards/1')['title'],'Dati da conservare')

    def test_online_backup_restores_planning_time_and_comment_threads(self):
        board = self.create_board('Backup integrato')
        bid = board['id']
        card = self.create_card(board['columns'][0]['id'],'Scheda completa',actual_minutes=7)
        self.api('POST',f'/api/boards/{bid}/fields',{'key':'cliente','name':'Cliente','type':'text'},expected=201)
        self.api('POST',f'/api/boards/{bid}/milestones',{'key':'release','title':'Release','due_date':'2026-11-01'},expected=201)
        self.api('PATCH',f'/api/cards/{card}',{'custom_values':{'cliente':'Caffè 🚀'},'milestone_key':'release'})
        self.api('POST',f'/api/cards/{card}/worklogs',{'date':'2026-10-16','minutes':23,'note':'Lavoro registrato'},expected=201)
        comment = self.api('POST',f'/api/cards/{card}/comments',{'body':'Discussione'},expected=201)['id']
        self.api('POST',f'/api/comments/{comment}/replies',{'body':'Risposta da conservare'},expected=201)
        full = self.api('GET',f'/api/cards/{card}')
        self.assertEqual(full['total_minutes'],30)
        backup = self.directory/'full-backup.sqlite3'
        result = subprocess.run([str(test_api.BINARY),'--db',str(self.db),'--backup',str(backup)],capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(connection.execute('SELECT count(*) FROM worklogs').fetchone()[0],1)
            self.assertEqual(connection.execute('SELECT count(*) FROM comments WHERE parent_id IS NOT NULL').fetchone()[0],1)
        self.api('PATCH',f'/api/cards/{card}',{'custom_values':{'cliente':'Modificato'}})
        self.stop_server()
        for suffix in ('-wal','-shm'):
            Path(str(self.db)+suffix).unlink(missing_ok=True)
        self.db.write_bytes(backup.read_bytes())
        self.start_server()
        restored = self.api('GET',f'/api/cards/{card}')
        self.assertEqual(restored['custom_values']['cliente'],'Caffè 🚀')
        self.assertEqual(restored['milestone_key'],'release')
        self.assertEqual(restored['total_minutes'],30)
        comments = self.api('GET',f'/api/cards/{card}/comments')['comments']
        self.assertIn('Risposta da conservare',[item['body'] for item in comments])


if __name__=='__main__': unittest.main()
