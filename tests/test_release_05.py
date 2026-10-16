"""Upgrade a database created by the real 0.4 binary, preserving its contents."""
from contextlib import closing
from pathlib import Path
import sqlite3
import unittest

import test_api


class Release05Migration(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api

    def test_real_v5_upgrade_keeps_fields_time_and_threads_and_private_backup(self):
        self.stop_server()
        for suffix in ('', '-wal', '-shm'):
            Path(str(self.db) + suffix).unlink(missing_ok=True)
        fixture = (test_api.ROOT / 'tests/fixtures/openboard_v5.sql').read_text(encoding='utf-8')
        with closing(sqlite3.connect(self.db)) as connection:
            connection.executescript(fixture)
        self.start_server()
        card = self.api('GET', '/api/cards/11')
        self.assertEqual(card['title'], 'Conservare revisione e report')
        self.assertEqual(card['custom_values'], {'score': 0})
        self.assertEqual(card['milestone_key'], 'release')
        self.assertEqual((card['actual_minutes'], card['logged_minutes'], card['total_minutes']), (7, 13, 20))
        self.assertEqual(card['checklist'], [{'id': 'keep', 'text': 'Caffè ☕', 'done': False}])
        comments = self.api('GET', '/api/cards/11/comments')['comments']
        self.assertEqual({comment['body'] for comment in comments}, {'Discussione precedente', 'Risposta precedente'})
        backup = Path(str(self.db) + '.pre-v5.bak')
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 5)
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertIsNone(connection.execute("SELECT name FROM sqlite_master WHERE name='reviews'").fetchone())
            self.assertEqual(connection.execute('SELECT sum(minutes) FROM worklogs').fetchone()[0], 13)
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 7)
            for table in ('reviews', 'review_members', 'review_votes', 'review_events', 'saved_reports'):
                self.assertEqual(connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0)
            self.assertEqual(connection.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.stop_server()
        self.start_server()
        self.assertEqual(self.api('GET', '/api/cards/11'), card)


if __name__ == '__main__':
    unittest.main()
