"""Recheck capacity after a real writer-lock wait, without production hooks."""
import concurrent.futures
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import shlex
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest

import test_auth as helpers

ROOT = Path(__file__).resolve().parents[1]


class StorageWriterLockPressure(unittest.TestCase):
    stop = helpers.OpenBoardAuth.stop
    read_log = helpers.OpenBoardAuth.read_log
    request = helpers.OpenBoardAuth.request
    api = helpers.OpenBoardAuth.api
    session = helpers.OpenBoardAuth.session
    sql = helpers.OpenBoardAuth.sql

    @classmethod
    def setUpClass(cls):
        cls.build_directory = tempfile.TemporaryDirectory(prefix='openboard-pressure-build-')
        cls.addClassCleanup(cls.build_directory.cleanup)
        cls.binary = Path(cls.build_directory.name) / 'openboard-pressure'
        compiler = shlex.split(os.environ.get('CC', 'cc'))
        flags = ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Wpedantic',
                 '-D_POSIX_C_SOURCE=200809L']
        flags += shlex.split(subprocess.check_output(['pkg-config', '--cflags', 'openssl'], text=True))
        libraries = shlex.split(subprocess.check_output(['pkg-config', '--libs', 'openssl'], text=True))
        if 'sanitize' in os.environ.get('OPENBOARD_BINARY', ''):
            flags += ['-fsanitize=address,undefined']
        sources = [str(path) for path in sorted((ROOT / 'src').glob('*.c'))
                   if path.name != 'storage.c']
        compiled = subprocess.run(
            [*compiler, *flags, str(ROOT / 'tests/fixtures/storage_pressure.c'),
             *sources, '-o', str(cls.binary), '-lsqlite3', '-pthread', *libraries],
            capture_output=True, text=True, timeout=60)
        if compiled.returncode:
            raise AssertionError('Pressure fixture build failed: ' + compiled.stderr)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openboard-pressure-http-')
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name)
        self.db = directory / 'test.db'
        self.pressure = directory / 'pressure'
        self.begin_signal = directory / 'begin'
        self.set_pressure('ok')
        self.log = (directory / 'server.log').open('w+b')
        self.addCleanup(self.log.close)
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0))
            self.port = reserve.getsockname()[1]
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith('OPENBOARD_')}
        environment.update({
            'OPENBOARD_FIXTURE_STORAGE_PRESSURE': str(self.pressure),
            'OPENBOARD_FIXTURE_STORAGE_BEGIN': str(self.begin_signal),
        })
        self.process = subprocess.Popen(
            [str(self.binary), '--port', str(self.port), '--db', str(self.db),
             '--auth', '--quiet', '--busy-timeout', '5000',
             '--cache-min-free-bytes', '1048576'],
            cwd=ROOT, env=environment, stdout=self.log, stderr=subprocess.STDOUT)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail('Pressure fixture startup failed: ' + self.read_log())
            try:
                if self.request('GET', '/api/health')[0] == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.025)
        else:
            self.fail('Pressure fixture did not start: ' + self.read_log())
        self.sessions = {}
        result, headers = self.api('POST', '/api/auth/setup', {
            'name': 'Alex', 'username': 'admin', 'password': helpers.PASSWORD,
        }, actor=None, expected=201)
        self.sessions['admin'] = self.session(result, headers)

    def set_pressure(self, state):
        self.pressure.write_text(state + '\n')

    def reject_after_wait(self, method, path, payload, *, actor='admin'):
        """Change capacity only after BEGIN has started against our held lock."""
        sent, finished = threading.Event(), threading.Event()
        headers = {'Content-Type': 'application/json',
                   'Origin': f'http://127.0.0.1:{self.port}'}
        if actor is not None:
            headers.update({'Cookie': self.sessions[actor]['cookie'],
                            'X-CSRF-Token': self.sessions[actor]['csrf']})

        def request():
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=7)
            try:
                connection.request(method, path, json.dumps(payload).encode(), headers)
                sent.set()
                response = connection.getresponse()
                return (response.status,
                        {key.lower(): value for key, value in response.getheaders()},
                        json.loads(response.read()))
            finally:
                connection.close()
                finished.set()

        # A fresh timestamp prevents a best-effort session touch from becoming
        # the first waiting writer: these cases exercise the mutation BEGIN.
        self.sql('UPDATE sessions SET last_seen=?', (int(time.time()),))
        self.begin_signal.unlink(missing_ok=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            with closing(sqlite3.connect(self.db, timeout=5, isolation_level=None)) as lock:
                lock.execute('BEGIN IMMEDIATE')
                pending = pool.submit(request)
                try:
                    self.assertTrue(sent.wait(timeout=2), 'HTTP request was not dispatched')
                    deadline = time.monotonic() + 3
                    observed = False
                    while time.monotonic() < deadline and not finished.is_set():
                        try:
                            observed = self.begin_signal.read_text() == 'BEGIN IMMEDIATE\n'
                        except FileNotFoundError:
                            pass
                        if observed:
                            break
                        finished.wait(timeout=.01)
                    self.assertTrue(observed, 'Real mutation BEGIN was not observed before pressure changed')
                    self.assertTrue(lock.in_transaction)
                    self.assertFalse(finished.wait(timeout=.05), 'Request did not remain blocked by the writer lock')
                    self.set_pressure('low')
                    lock.execute('COMMIT')
                finally:
                    if lock.in_transaction:
                        lock.execute('ROLLBACK')
            return pending.result(timeout=7)

    def test_domain_write_rechecks_pressure_after_wait_without_partial_effects(self):
        original = self.sql('SELECT title,version FROM cards WHERE id=1')
        activity = self.sql('SELECT count(*) FROM activity')
        boards = self.sql('SELECT id,version FROM boards ORDER BY id')
        status, headers, body = self.reject_after_wait(
            'PATCH', '/api/cards/1', {'title': 'Rejected after lock wait'})
        self.assertEqual(status, 503, body)
        self.assertTrue(body.get('error'))
        self.assertNotIn('set-cookie', headers)
        self.assertEqual(self.sql('SELECT title,version FROM cards WHERE id=1'), original)
        self.assertEqual(self.sql('SELECT count(*) FROM activity'), activity)
        self.assertEqual(self.sql('SELECT id,version FROM boards ORDER BY id'), boards)
        self.set_pressure('ok')
        self.api('PATCH', '/api/cards/1', {'title': 'Accepted after pressure clears'})
        self.assertEqual(self.sql('SELECT title FROM cards WHERE id=1'), [('Accepted after pressure clears',)])

    def test_login_rechecks_pressure_after_wait_without_creating_session(self):
        sessions = self.sql('SELECT token_hash,csrf,user_id,expires_at FROM sessions ORDER BY token_hash')
        account = self.sql('SELECT password_hash,salt FROM users WHERE id=1')
        payload = {'username': 'admin', 'password': helpers.PASSWORD}
        status, headers, body = self.reject_after_wait(
            'POST', '/api/auth/login', payload, actor=None)
        self.assertEqual(status, 503, body)
        self.assertTrue(body.get('error'))
        self.assertNotIn('set-cookie', headers)
        self.assertEqual(self.sql('SELECT token_hash,csrf,user_id,expires_at FROM sessions ORDER BY token_hash'), sessions)
        self.assertEqual(self.sql('SELECT password_hash,salt FROM users WHERE id=1'), account)
        self.set_pressure('ok')
        result, successful_headers = self.api('POST', '/api/auth/login', payload, actor=None)
        self.assertEqual(result['user']['id'], 1)
        self.assertIn('set-cookie', successful_headers)
        self.assertEqual(self.sql('SELECT count(*) FROM sessions')[0][0], len(sessions) + 1)

    def test_failed_filesystem_measurement_is_unknown_and_rejects_writes(self):
        original = self.sql('SELECT title,version FROM cards WHERE id=1')
        self.set_pressure('error')
        inventory, _ = self.api('GET', '/api/admin/storage')
        self.assertIsNone(inventory['cache']['filesystem_available_bytes'])
        self.assertFalse(inventory['cache']['measurement_available'])
        self.assertFalse(inventory['cache']['capacity_ok'])
        status, _, metrics = self.request('GET', '/api/metrics', headers={
            'Cookie': self.sessions['admin']['cookie']})
        self.assertEqual(status, 200)
        self.assertNotIn(b'openboard_cache_filesystem_available_bytes', metrics)
        self.assertIn(b'openboard_cache_measurement_available 0\n', metrics)
        self.api('PATCH', '/api/cards/1', {'title': 'Unknown capacity'}, expected=503)
        self.assertEqual(self.sql('SELECT title,version FROM cards WHERE id=1'), original)
        self.set_pressure('ok')
        restored, _ = self.api('GET', '/api/admin/storage')
        self.assertTrue(restored['cache']['measurement_available'])
        self.assertTrue(restored['cache']['capacity_ok'])
        self.assertEqual(restored['cache']['filesystem_available_bytes'], 4096 * 1048576)


if __name__ == '__main__':
    unittest.main()
