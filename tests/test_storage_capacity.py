"""Logical retained-file quotas and cache pressure on disposable SQLite stores."""
import base64
import concurrent.futures
import json
import os
import subprocess
import time
import unittest

import test_auth as helpers


class StorageCapacityTests(unittest.TestCase):
    setUp = helpers.OpenBoardAuth.setUp
    stop = helpers.OpenBoardAuth.stop
    read_log = helpers.OpenBoardAuth.read_log
    request = helpers.OpenBoardAuth.request
    api = helpers.OpenBoardAuth.api
    session = helpers.OpenBoardAuth.session
    add_user = helpers.OpenBoardAuth.add_user
    login = helpers.OpenBoardAuth.login
    sql = helpers.OpenBoardAuth.sql

    def restart(self, *options):
        self.stop()
        self.process = subprocess.Popen(
            [str(helpers.BINARY), '--port', str(self.port), '--db', str(self.db),
             '--auth', '--quiet', *map(str, options)], cwd=helpers.ROOT,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail('Restart failed: ' + self.read_log())
            try:
                if self.request('GET', '/api/health')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.025)
        self.fail('Restart timed out')

    def upload(self, value=b'abc', card=1, expected=201, headers=None):
        return self.api('POST', f'/api/cards/{card}/attachments', {
            'name': 'quota.txt', 'mime': 'text/plain',
            'data_base64': base64.b64encode(value).decode()},
            expected=expected, headers=headers)[0]

    def inventory(self):
        data, headers = self.api('GET', '/api/admin/storage')
        self.assertEqual(headers['cache-control'], 'no-store')
        return data

    def test_inventory_acl_limits_history_and_no_sensitive_metadata(self):
        self.api('GET', '/api/admin/storage', actor=None, expected=401)
        self.add_user('member')
        self.login('member')
        self.api('GET', '/api/admin/storage', actor='member', expected=403)
        data = self.inventory()
        self.assertEqual(data['storage_mode'], 'sqlite')
        self.assertEqual(data['attachments']['limits'], {'files': 0, 'bytes': 0})
        self.assertEqual(data['attachments']['remaining'], {'files': None, 'bytes': None})
        self.assertTrue(data['cache']['measurement_available'])
        self.assertGreater(data['cache']['logical_database_bytes'], 0)
        self.assertGreaterEqual(data['cache']['filesystem_available_bytes'], 0)
        self.assertEqual(data['history']['activity_rows'], self.sql('SELECT count(*) FROM activity')[0][0])
        payload = json.dumps(data)
        for private in (str(self.db), 'postgresql://', 'mongodb://', 'token_hash', 'password'):
            self.assertNotIn(private, payload)
        self.api('POST', '/api/admin/storage', {}, expected=405)

    def test_exact_byte_boundary_and_retained_trash(self):
        self.restart('--attachment-limit-bytes', 6)
        first = self.upload(b'abc')['id']
        self.upload(b'def')
        self.upload(b'x', expected=409)
        self.api('DELETE', f'/api/attachments/{first}')
        state = self.inventory()['attachments']
        self.assertEqual(state['total'], {'files': 2, 'bytes': 6})
        self.assertEqual(state['active'], {'files': 1, 'bytes': 3})
        self.assertEqual(state['trashed'], {'files': 1, 'bytes': 3})
        self.assertEqual(state['remaining']['bytes'], 0)
        self.upload(b'x', expected=409)
        self.api('POST', f'/api/attachments/{first}/restore', {})
        self.assertEqual(self.inventory()['attachments']['total'], state['total'])

    def test_zero_byte_files_and_overlapping_parent_trash(self):
        self.restart('--attachment-limit-files', 2)
        a = self.upload(b'')['id']
        self.upload(b'x')
        self.upload(b'', expected=409)
        self.api('DELETE', f'/api/attachments/{a}')
        self.api('DELETE', '/api/cards/1')
        self.api('DELETE', '/api/columns/1')
        self.api('DELETE', '/api/boards/1')
        state = self.inventory()['attachments']
        self.assertEqual(state['total'], {'files': 2, 'bytes': 1})
        self.assertEqual(state['active'], {'files': 0, 'bytes': 0})
        self.assertEqual(state['trashed'], state['total'])

    def test_lowered_quota_preserves_files_and_allows_restore(self):
        a = self.upload(b'abc')['id']
        self.api('DELETE', f'/api/attachments/{a}')
        self.restart('--attachment-limit-bytes', 1)
        self.assertTrue(self.inventory()['attachments']['over_limit'])
        self.api('POST', f'/api/attachments/{a}/restore', {})
        self.api('GET', f'/api/attachments/{a}')
        self.upload(b'', expected=409)
        self.assertEqual(self.inventory()['attachments']['total']['bytes'], 3)

    def test_concurrent_upload_admission_and_idempotency_replay(self):
        self.restart('--attachment-limit-files', 1)
        body = {'name': 'race.txt', 'mime': 'text/plain', 'data_base64': 'YQ=='}
        headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}',
                   'Cookie': self.sessions['admin']['cookie'], 'X-CSRF-Token': self.sessions['admin']['csrf']}
        def upload(key):
            return self.request('POST', '/api/cards/1/attachments', json.dumps(body).encode(),
                                {**headers, 'Idempotency-Key': key})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(upload, ['quota-race-a', 'quota-race-b']))
        self.assertEqual(sorted(r[0] for r in replies), [201, 409])
        winner = ['quota-race-a', 'quota-race-b'][next(i for i, r in enumerate(replies) if r[0] == 201)]
        repeated = upload(winner)
        self.assertEqual(repeated[0], 201)
        self.assertEqual(json.loads(repeated[2]), json.loads(next(r[2] for r in replies if r[0] == 201)))
        self.assertEqual(self.inventory()['attachments']['total'], {'files': 1, 'bytes': 1})
        self.assertGreater(self.inventory()['history']['idempotency_request_bytes'], 0)

    def test_failed_event_rolls_back_quota_usage(self):
        self.restart('--attachment-limit-files', 1)
        self.sql("CREATE TRIGGER fail_storage_event BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.upload(expected=503)
        self.assertEqual(self.inventory()['attachments']['total']['files'], 0)
        self.sql('DROP TRIGGER fail_storage_event')
        self.upload()
        self.assertEqual(self.inventory()['attachments']['total']['files'], 1)

    def test_archive_orphan_accounting_and_clones_never_bypass_retained_quota(self):
        self.restart('--attachment-limit-files', 1)
        self.upload()
        self.api('PATCH', '/api/cards/1', {'archived': True})
        self.assertEqual(self.inventory()['attachments']['active']['files'], 1)
        self.api('POST', '/api/cards/1/duplicate', {}, expected=201)
        exported, _ = self.api('GET', '/api/boards/1/export')
        self.api('POST', '/api/import', exported, expected=201)
        self.api('POST', '/api/boards/1/duplicate', {}, expected=201)
        self.assertEqual(self.inventory()['attachments']['total']['files'], 1)
        # Damaged/unlinked rows are still retained bytes, never quota-free.
        self.sql("UPDATE attachments SET card_id=999999")
        data = self.inventory()['attachments']
        self.assertEqual(data['active']['files'], 0)
        self.assertEqual(data['trashed'], {'files': 1, 'bytes': 3})
        self.assertEqual(data['total'], data['trashed'])
        self.upload(card=2, expected=409)

    def test_inventory_and_admission_sql_errors_fail_closed(self):
        self.restart('--attachment-limit-files', 1)
        self.sql('ALTER TABLE attachments RENAME TO unavailable_attachments')
        self.api('GET', '/api/admin/storage', expected=503)
        self.upload(expected=503)
        self.assertEqual(self.sql('SELECT count(*) FROM unavailable_attachments')[0][0], 0)

    def test_pressure_rejects_writes_preserves_reads_and_session_expiry(self):
        self.sql('UPDATE sessions SET last_seen=?', (int(time.time()) - 61,))
        before = self.sql('SELECT last_seen,expires_at FROM sessions')
        self.restart('--cache-min-free-bytes', 1125899906842624)
        self.assertEqual(self.request('GET', '/api/ready')[0], 503)
        self.api('GET', '/api/boards')
        self.assertFalse(self.inventory()['cache']['capacity_ok'])
        self.assertEqual(self.sql('SELECT last_seen,expires_at FROM sessions'), before)
        self.api('PATCH', '/api/cards/1', {'title': 'pressure'}, expected=503)
        self.api('POST', '/api/auth/login', {'username': 'admin', 'password': helpers.PASSWORD}, actor=None, expected=503)
        self.assertNotEqual(self.sql('SELECT title FROM cards WHERE id=1')[0][0], 'pressure')
        self.sql('UPDATE sessions SET last_seen=?', (int(time.time()) - 1801,))
        self.api('GET', '/api/boards', expected=401)
        self.restart()
        self.assertEqual(self.request('GET', '/api/ready')[0], 200)

    def test_page_cap_rolls_back_large_write_and_refuses_smaller_existing_database(self):
        state = self.inventory()['cache']
        cap = state['logical_database_bytes'] + 16384
        self.restart('--cache-max-bytes', cap)
        self.upload(b'x' * 1048576, expected=503)
        self.assertEqual(self.inventory()['attachments']['total']['files'], 0)
        self.assertLessEqual(self.inventory()['cache']['logical_database_bytes'], cap)
        self.stop()
        result = subprocess.run([str(helpers.BINARY), '--db', str(self.db), '--cache-max-bytes', '4096'],
                                cwd=helpers.ROOT, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.sql('PRAGMA integrity_check'), [('ok',)])


class StorageConfigTests(unittest.TestCase):
    def test_invalid_configuration_and_diagnostic_cli_precedence(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('OPENBOARD_')}
        for option in ('attachment-limit-bytes', 'attachment-limit-files', 'cache-max-bytes', 'cache-min-free-bytes'):
            for value in ('-1', '1.5', 'no', '9223372036854775808', ''):
                result = subprocess.run([str(helpers.BINARY), '--' + option, value, '--diagnostics'],
                                        env=env, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0, (option, value))
            result = subprocess.run([str(helpers.BINARY), '--diagnostics'],
                                    env={**env, 'OPENBOARD_' + option.replace('-', '_').upper(): '-1'},
                                    capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0, option)
        result = subprocess.run([str(helpers.BINARY), '--diagnostics', '--attachment-limit-bytes', '128'],
                                env={**env, 'OPENBOARD_ATTACHMENT_LIMIT_BYTES': '64'}, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['attachment_limit_bytes'], 128)


if __name__ == '__main__':
    unittest.main()
