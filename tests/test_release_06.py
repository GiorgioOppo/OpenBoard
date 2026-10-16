"""Migrate a real 0.5 database without losing reviews, reports or accounts."""
from contextlib import closing
from pathlib import Path
import json
import sqlite3
import unittest

import test_api


class Release06Migration(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api

    def test_real_v6_upgrade_preserves_approved_reviews_reports_time_and_private_backup(self):
        self.stop_server()
        for suffix in ('', '-wal', '-shm'):
            Path(str(self.db) + suffix).unlink(missing_ok=True)
        fixture = (test_api.ROOT / 'tests/fixtures/openboard_v6.sql').read_text(encoding='utf-8')
        with closing(sqlite3.connect(self.db)) as connection:
            connection.executescript(fixture)
        self.start_server()
        card = self.api('GET', '/api/cards/1')
        self.assertEqual(card['total_minutes'], 13)
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 7)
            self.assertEqual(connection.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(connection.execute("SELECT status FROM review_resolved WHERE id=1").fetchone()[0], 'approved')
            self.assertEqual(connection.execute('SELECT decision,note FROM review_votes WHERE review_id=1').fetchone(), ('approved', 'Verificato ☕'))
            filters, pinned = connection.execute("SELECT filters,pinned FROM saved_reports WHERE name='Report da conservare'").fetchone()
            self.assertEqual(json.loads(filters), {'q': 'Caffè', 'status': 'open', 'include_archived': False})
            self.assertEqual(pinned, 1)
            self.assertEqual(connection.execute('SELECT count(*) FROM review_events WHERE review_id=1').fetchone()[0], 2)
            self.assertEqual(connection.execute('SELECT username FROM users ORDER BY id').fetchall(), [('admin',), ('alice',)])
            for table in ('sprints', 'sprint_cards', 'sprint_capacity', 'sprint_snapshots', 'sprint_events',
                          'intake_forms', 'intake_fields', 'intake_requests', 'intake_notes', 'intake_events'):
                self.assertEqual(connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0)
        backup = Path(str(self.db) + '.pre-v6.bak')
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 6)
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertIsNone(connection.execute("SELECT name FROM sqlite_master WHERE name='sprints'").fetchone())
        self.stop_server()
        self.start_server()
        self.assertEqual(self.api('GET', '/api/cards/1'), card)


if __name__ == '__main__':
    unittest.main()
