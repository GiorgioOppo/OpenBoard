"""Explicit v1 aliases preserve authenticated transport and mutation controls."""
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest

from auth_clock import authentication_clock_binary
import test_auth


class APIVersioning(unittest.TestCase):
    stop = test_auth.OpenBoardAuth.stop
    read_log = test_auth.OpenBoardAuth.read_log
    request = test_auth.OpenBoardAuth.request
    session = test_auth.OpenBoardAuth.session
    login = test_auth.OpenBoardAuth.login
    add_user = test_auth.OpenBoardAuth.add_user

    def api(self, *args, **kwargs):
        result, headers = test_auth.OpenBoardAuth.api(self, *args, **kwargs)
        self.assertEqual(headers.get('openboard-api-version'), '1')
        self.assertNotIn('location', headers)
        return result, headers

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openboard-api-version-')
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'test.db'
        self.log = (Path(self.temp.name) / 'server.log').open('w+b')
        self.addCleanup(self.log.close)
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0))
            self.port = reserve.getsockname()[1]
        binary = (authentication_clock_binary()
                  if self._testMethodName == 'test_login_aliases_share_one_native_rate_limit'
                  else test_auth.BINARY)
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith('OPENBOARD_')}
        self.process = subprocess.Popen(
            [str(binary), '--port', str(self.port), '--db', str(self.db),
             '--auth', '--no-demo', '--quiet'], cwd=test_auth.ROOT,
            env=environment, stdout=self.log, stderr=subprocess.STDOUT)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail('Server startup failed: ' + self.read_log())
            try:
                if self.request('GET', '/api/v1/health')[0] == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.025)
        else:
            self.fail('Server did not start: ' + self.read_log())
        self.sessions = {}
        before, _ = self.api('GET', '/api/v1/auth/session', actor=None)
        self.assertTrue(before['setup_required'])
        result, headers = self.api('POST', '/api/v1/auth/setup', {
            'name': 'Synthetic administrator', 'username': 'admin',
            'password': test_auth.PASSWORD}, actor=None, expected=201)
        self.sessions['admin'] = self.session(result, headers)

    def sql(self, query, parameters=()):
        with closing(sqlite3.connect(self.db)) as connection, connection:
            return connection.execute(query, parameters).fetchall()

    def board(self, prefix='/api'):
        result, _ = self.api('POST', prefix + '/boards',
                             {'name': 'Synthetic versioned board'}, expected=201)
        return self.api('GET', prefix + '/boards/' + str(result['id']))[0]

    def test_public_metadata_health_readiness_and_head_aliases(self):
        for resource in ('health', 'ready', 'version'):
            canonical, _ = self.api('GET', '/api/' + resource, actor=None)
            versioned, _ = self.api('GET', '/api/v1/' + resource, actor=None)
            self.assertEqual(canonical, versioned)
            status, headers, body = self.request('HEAD', '/api/v1/' + resource)
            self.assertEqual(status, 200)
            self.assertEqual(headers['openboard-api-version'], '1')
            self.assertEqual(body, b'')
            self.assertGreater(int(headers['content-length']), 0)
        metadata, _ = self.api('GET', '/api/v1/version', actor=None)
        self.assertEqual(metadata['version'], '0.6.1')
        self.assertEqual(metadata['api'], {
            'version': 1, 'supported_versions': [1], 'base_path': '/api/v1',
            'unversioned_alias': '/api', 'alias_version': 1,
            'deprecated': False, 'sunset': None})
        self.api('POST', '/api/v1/version', {}, actor=None, expected=405)
        status, headers, _ = self.request('GET', '/styles.css')
        self.assertEqual(status, 404)
        self.assertNotIn('openboard-api-version', headers)

    def test_login_session_logout_and_setup_share_authentication(self):
        self.api('POST', '/api/auth/setup', {}, actor=None, expected=409)
        result, headers = self.api('POST', '/api/v1/auth/login', {
            'username': 'ADMIN', 'password': test_auth.PASSWORD}, actor=None)
        self.sessions['second'] = self.session(result, headers)
        canonical, _ = self.api('GET', '/api/auth/session', actor='second')
        versioned, _ = self.api('GET', '/api/v1/auth/session', actor='second')
        self.assertEqual(canonical, versioned)
        self.api('POST', '/api/v1/auth/logout', {}, actor='second')
        result, _ = self.api('GET', '/api/auth/session', actor='second')
        self.assertIsNone(result['user'])
        self.api('GET', '/api/v1/boards', actor='second', expected=401)

    def test_aliases_preserve_csrf_origin_acl_and_observer_checks(self):
        board = self.board()
        observer = self.add_user('version.observer', 'observer')
        self.login('version.observer')
        for prefix in ('/api', '/api/v1'):
            self.api('GET', prefix + '/boards', actor=None, expected=401)
            self.api('POST', prefix + '/boards', {'name': 'Blocked CSRF'},
                     headers={'X-CSRF-Token': ''}, expected=403)
            self.api('POST', prefix + '/boards', {'name': 'Blocked origin'},
                     headers={'Origin': 'https://untrusted.invalid'}, expected=403)
            self.api('GET', prefix + '/boards/' + str(board['id']),
                     actor='version.observer', expected=404)
        self.api('POST', f'/api/v1/boards/{board["id"]}/members',
                 {'user_id': observer, 'role': 'observer'})
        for prefix in ('/api', '/api/v1'):
            self.api('GET', prefix + '/boards/' + str(board['id']),
                     actor='version.observer')
            self.api('PATCH', prefix + '/boards/' + str(board['id']),
                     {'name': 'Blocked observer'}, actor='version.observer', expected=403)
        self.assertEqual(self.sql('SELECT count(*) FROM boards'), [(1,)])

    def test_aliases_share_idempotency_keys_in_both_directions(self):
        for index, (first, second) in enumerate((('/api', '/api/v1'),
                                                ('/api/v1', '/api'))):
            key = 'synthetic-version-key-' + str(index)
            body = {'name': 'Synthetic retry ' + str(index)}
            headers = {'Idempotency-Key': key}
            created, _ = self.api('POST', first + '/boards', body,
                                  headers=headers, expected=201)
            replayed, response = self.api('POST', second + '/boards', body,
                                          headers=headers, expected=201)
            self.assertEqual(replayed, created)
            self.assertEqual(response['idempotency-replayed'], 'true')
            self.api('POST', second + '/boards', {'name': 'Different body'},
                     headers=headers, expected=409)
            self.assertEqual(self.sql('SELECT path FROM idempotency WHERE key=?',
                                      (key,)), [('/api/boards',)])
        self.assertEqual(self.sql('SELECT count(*) FROM boards'), [(2,)])

    def test_replayed_alias_still_checks_current_board_membership(self):
        member = self.add_user('version.member')
        self.login('version.member')
        board = self.board()
        self.api('POST', f'/api/boards/{board["id"]}/members',
                 {'user_id': member, 'role': 'member'})
        path = f'/columns/{board["columns"][0]["id"]}/cards'
        headers = {'Idempotency-Key': 'synthetic-acl-version-key'}
        body = {'title': 'Synthetic retried card'}
        self.api('POST', '/api/v1' + path, body, actor='version.member',
                 headers=headers, expected=201)
        self.api('DELETE', f'/api/boards/{board["id"]}/members/{member}')
        self.api('POST', '/api' + path, body, actor='version.member',
                 headers=headers, expected=404)
        self.assertEqual(self.sql('SELECT count(*) FROM cards'), [(1,)])

    def test_if_match_preconditions_are_shared_across_aliases(self):
        board = self.board('/api/v1')
        path = '/boards/' + str(board['id'])
        initial = str(board['version'])
        updated, _ = self.api('PATCH', '/api/v1' + path, {'name': 'First change'},
                              headers={'If-Match': '"' + initial + '"'})
        self.api('PATCH', '/api' + path, {'name': 'Stale change'},
                 headers={'If-Match': initial}, expected=412)
        again, _ = self.api('PATCH', '/api' + path, {'name': 'Second change'},
                            headers={'If-Match': str(updated['version'])})
        self.api('PATCH', '/api/v1' + path, {'name': 'Other stale change'},
                 headers={'If-Match': str(updated['version'])}, expected=412)
        result, _ = self.api('GET', '/api/v1' + path)
        self.assertEqual(result['name'], 'Second change')
        self.assertEqual(result['version'], again['version'])

    def test_query_remains_separate_and_uses_existing_decoding_rules(self):
        board = self.board()
        column = board['columns'][0]['id']
        self.api('POST', f'/api/v1/columns/{column}/cards',
                 {'title': 'Caffè /api/v1 marker'}, expected=201)
        query = '?q=Caff%C3%A8+%2Fapi%2Fv1&kind=card'
        canonical, _ = self.api('GET', '/api/search/content' + query)
        versioned, _ = self.api('GET', '/api/v1/search/content' + query)
        self.assertEqual(canonical, versioned)
        self.assertTrue(versioned['items'])
        for prefix in ('/api', '/api/v1'):
            self.api('GET', prefix + '/search/content?q=one&q=two', expected=400)
            self.api('GET', prefix + '/search/content?q=%00', expected=400)

    def test_unknown_and_misleading_version_paths_never_mutate_or_redirect(self):
        for version in ('v0', 'v2', 'v9999999999999999999999999999999999999999'):
            for actor in (None, 'admin'):
                result, _ = self.api('POST', '/api/' + version + '/boards',
                                     {'name': 'Must not exist'}, actor=actor, expected=404)
                self.assertEqual(result['code'], 'unsupported_api_version')
                self.assertEqual(result['supported_versions'], [1])
                self.assertLess(len(json.dumps(result)), 256)
        for path in ('/api/v01/boards', '/api/v1suffix/boards',
                     '/api/v1.0/boards', '/api/v1', '/api/v1/',
                     '/api/v1/v1/boards', '/api/v1//boards',
                     '/api/v1/boards/', '/api/v1/%62oards'):
            result, _ = self.api('POST', path, {'name': 'Must not exist'}, expected=404)
            self.assertLess(len(json.dumps(result)), 256)
        self.assertEqual(self.sql('SELECT count(*) FROM boards'), [(0,)])
        self.assertEqual(self.sql('SELECT count(*) FROM idempotency'), [(0,)])

    def test_transport_errors_include_the_api_version_header(self):
        for path in ('/api/boards', '/api/v1/boards'):
            status, headers, body = self.request('GET', path, headers={
                'Host': 'untrusted.invalid'})
            self.assertEqual(status, 403)
            self.assertEqual(headers['openboard-api-version'], '1')
            self.assertTrue(json.loads(body)['error'])
            status, headers, body = self.request('POST', path, b'\xff', {
                'Content-Type': 'application/json'})
            self.assertEqual(status, 400)
            self.assertEqual(headers['openboard-api-version'], '1')
            self.assertTrue(json.loads(body)['error'])

    def test_login_aliases_share_one_native_rate_limit(self):
        for index in range(10):
            prefix = '/api/v1' if index % 2 else '/api'
            self.api('POST', prefix + '/auth/login', {
                'username': 'synthetic-missing', 'password': 'synthetic-wrong'},
                actor=None, expected=401)
        for prefix in ('/api/v1', '/api'):
            _, headers = self.api('POST', prefix + '/auth/login', {
                'username': 'synthetic-missing', 'password': 'synthetic-wrong'},
                actor=None, expected=429)
            self.assertEqual(headers['retry-after'], '300')


if __name__ == '__main__':
    unittest.main()
