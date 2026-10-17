"""Coherent bounded telemetry with native concurrency, offline drivers and HTTP."""
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import tempfile
import time
import unittest
import uuid

from auth_clock import authentication_clock_binary

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('OPENBOARD_BINARY', ROOT / 'build/openboard'))


def fixture_binary(test, source, packages=(), external=False):
    directory = tempfile.TemporaryDirectory(prefix='openboard-telemetry-fixture-')
    test.addClassCleanup(directory.cleanup)
    executable = Path(directory.name) / 'telemetry'
    compiler = shlex.split(os.environ.get('CC', 'cc'))
    flags = ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Wpedantic',
             '-D_POSIX_C_SOURCE=200809L']
    libraries = ['-pthread', '-lm']
    if packages:
        flags += shlex.split(subprocess.check_output(['pkg-config', '--cflags', *packages], text=True))
        libraries += shlex.split(subprocess.check_output(['pkg-config', '--libs', *packages], text=True))
    if external:
        flags += ['-DOB_EXTERNAL_STORAGE']
        libraries += ['-lsqlite3']
    if 'sanitize' in os.environ.get('OPENBOARD_BINARY', ''):
        flags += ['-fsanitize=address,undefined']
    result = subprocess.run([*compiler, *flags, str(ROOT / 'tests/fixtures' / source),
                             str(ROOT / 'src/telemetry.c'), '-o', str(executable), *libraries],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    return executable


def metrics(body):
    return dict(line.split() for line in body.decode().splitlines()
                if line and not line.startswith('#'))


class TelemetryNative(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.executable = fixture_binary(cls, 'telemetry.c')

    def run_case(self, case, expected):
        result = subprocess.run([str(self.executable), case], capture_output=True,
                                text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(expected, result.stdout)

    def test_boundaries_rejected_inputs_and_no_partial_exposition(self):
        self.run_case('boundaries', 'bounded output OK')

    def test_concurrent_writers_and_coherent_exports(self):
        self.run_case('concurrent', 'coherent exports OK')


class TelemetryOfflineStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mongo = next((name for name in ('libmongoc-1.0', 'mongoc2')
                      if subprocess.run(['pkg-config', '--exists', name], check=False).returncode == 0), None)
        if not mongo or subprocess.run(['pkg-config', '--exists', 'libpq'], check=False).returncode:
            raise unittest.SkipTest('Native PostgreSQL/MongoDB development drivers are required')
        cls.executable = fixture_binary(cls, 'telemetry_cloud.c', ['libpq', mongo, 'openssl'], True)

    def test_operation_failures_and_only_committed_rows_are_counted(self):
        result = subprocess.run([str(self.executable)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('confirmed publication row counts OK', result.stdout)


class TelemetryHTTP(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='openboard-telemetry-http-')
        self.addCleanup(self.directory.cleanup)
        self.process = None
        self.addCleanup(self.stop)

    def start(self, authenticated=False, binary=BINARY):
        with socket.socket() as connection:
            connection.bind(('127.0.0.1', 0))
            self.port = connection.getsockname()[1]
        self.authority = f'telemetry-{uuid.uuid4().hex}.localhost:{self.port}'
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith('OPENBOARD_')}
        self.process = subprocess.Popen(
            [str(binary), '--port', str(self.port), '--db', str(Path(self.directory.name) / 'test.db'),
             '--public-url', 'http://' + self.authority, '--no-demo', '--quiet',
             '--auth' if authenticated else '--no-auth'],
            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail('Disposable telemetry server failed: ' + self.process.stderr.read().decode())
            try:
                if self.request('GET', '/api/health')[0] == 200:
                    return
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.025)
        self.fail('Disposable telemetry server startup timeout')

    def stop(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
            if self.process.stderr:
                self.process.stderr.close()
            self.process = None

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers={'Host': self.authority, **(headers or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def export(self, headers=None):
        status, response_headers, body = self.request('GET', '/api/metrics', headers=headers)
        self.assertEqual(status, 200, body)
        self.assertEqual(response_headers['Cache-Control'], 'no-store')
        self.assertIn('text/plain; version=0.0.4', response_headers['Content-Type'])
        values = metrics(body)
        count = int(values['openboard_http_request_duration_seconds_count'])
        classes = sum(int(values[f'openboard_http_responses_total{{class="{status}xx"}}'])
                      for status in range(2, 6))
        self.assertEqual(classes, count)
        previous = 0
        for limit in ('0.001', '0.005', '0.01', '0.025', '0.05', '0.1', '0.25',
                      '0.5', '1', '2.5', '5', '10', '+Inf'):
            current = int(values[f'openboard_http_request_duration_seconds_bucket{{le="{limit}"}}'])
            self.assertGreaterEqual(current, previous)
            self.assertLessEqual(current, count)
            previous = current
        self.assertEqual(previous, count)
        self.assertGreaterEqual(float(values['openboard_http_request_duration_seconds_sum']), 0)
        self.assertLessEqual(int(values['openboard_http_rate_limited_total']),
                             int(values['openboard_http_responses_total{class="4xx"}']))
        return values, body

    def test_real_responses_histogram_labels_legacy_names_and_no_user_data(self):
        self.start()
        self.assertEqual(self.request('GET', '/api/missing-private-marker?token=private-marker')[0], 404)
        self.assertEqual(self.request('POST', '/api/boards', '{', {'Content-Type': 'application/json'})[0], 400)
        values, body = self.export()
        self.assertGreaterEqual(int(values['openboard_http_responses_total{class="4xx"}']), 1)
        for name in ('openboard_http_requests_total', 'openboard_http_errors_total',
                     'openboard_http_duration_seconds_total', 'openboard_http_active',
                     'openboard_http_queued', 'openboard_http_overloads_total', 'openboard_workers'):
            self.assertIn(name, values)
        self.assertNotIn(b'private-marker', body)
        for name in values:
            if name.startswith(('openboard_storage_operation_', 'openboard_http_request_duration_',
                                'openboard_http_responses_')) and '{' in name:
                self.assertLessEqual(set(re.findall(r'([a-z_]+)=', name)), {'operation', 'le', 'class'})
        self.assertEqual(int(values['openboard_storage_operation_duration_seconds_count{operation="publish"}']), 0)

    def test_admin_gate_and_rate_limit_are_reflected_in_fixed_counters(self):
        self.start(authenticated=True, binary=authentication_clock_binary())
        self.assertEqual(self.request('GET', '/api/metrics')[0], 401)
        status, headers, body = self.request('POST', '/api/auth/setup', json.dumps({
            'name': 'Telemetry administrator', 'username': 'telemetry.admin',
            'password': 'Telemetry-admin-password!'}), {'Content-Type': 'application/json'})
        self.assertEqual(status, 201, body)
        session = json.loads(body)
        admin = {'Cookie': headers['Set-Cookie'].split(';')[0],
                 'X-CSRF-Token': session['csrf'], 'Content-Type': 'application/json'}
        self.export(admin)
        status, _, body = self.request('POST', '/api/users', json.dumps({
            'name': 'Telemetry member', 'username': 'telemetry.member',
            'password': 'Telemetry-member-password!', 'role': 'member'}), admin)
        self.assertEqual(status, 201, body)
        status, headers, body = self.request('POST', '/api/auth/login', json.dumps({
            'username': 'telemetry.member', 'password': 'Telemetry-member-password!'}),
            {'Content-Type': 'application/json'})
        self.assertEqual(status, 200, body)
        member = {'Cookie': headers['Set-Cookie'].split(';')[0]}
        self.assertEqual(self.request('GET', '/api/metrics', headers=member)[0], 403)
        for _ in range(10):
            status, _, _ = self.request('POST', '/api/auth/login', json.dumps({
                'username': 'telemetry.unknown', 'password': 'Incorrect-password!'}),
                {'Content-Type': 'application/json'})
            self.assertEqual(status, 401)
        self.assertEqual(self.request('POST', '/api/auth/login', json.dumps({
            'username': 'telemetry.unknown', 'password': 'Incorrect-password!'}),
            {'Content-Type': 'application/json'})[0], 429)
        # A response is observed after transmission; wait for its completion on
        # the worker before checking a subsequent worker's coherent snapshot.
        for _ in range(10):
            values, _ = self.export(admin)
            if int(values['openboard_http_rate_limited_total']) == 1:
                break
            time.sleep(.01)
        self.assertEqual(int(values['openboard_http_rate_limited_total']), 1)
        self.assertGreaterEqual(int(values['openboard_http_responses_total{class="4xx"}']), 13)


if __name__ == '__main__':
    unittest.main()
