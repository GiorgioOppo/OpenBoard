"""Real authenticated API round trips through the loopback development frontend."""
import http.client
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('OPENBOARD_BINARY', ROOT/'build/openboard'))

SPEC = importlib.util.spec_from_file_location('openboard_dev_frontend', ROOT/'scripts/dev-frontend.py')
DEV = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEV)


def free_port():
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        return reserve.getsockname()[1]


class DevelopmentFrontend(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='openboard-dev-frontend-')
        self.addCleanup(self.folder.cleanup)
        self.backend_port, self.frontend_port = free_port(), free_port()
        while self.frontend_port == self.backend_port:
            self.frontend_port = free_port()
        self.origin = f'http://127.0.0.1:{self.frontend_port}'
        environment = {key:value for key,value in os.environ.items() if not key.startswith('OPENBOARD_')}
        self.log = tempfile.TemporaryFile()
        self.addCleanup(self.log.close)
        self.processes = []
        self.addCleanup(self.stop)
        for command in ([str(BINARY), '--port', str(self.backend_port), '--db', str(Path(self.folder.name)/'cache.db'), '--auth', '--no-demo', '--quiet', '--public-url', self.origin],
                        [sys.executable, str(ROOT/'scripts/dev-frontend.py'), '--port', str(self.frontend_port), '--backend', f'http://127.0.0.1:{self.backend_port}']):
            self.processes.append(subprocess.Popen(command, env=environment, stdout=self.log, stderr=self.log))
        deadline = time.monotonic()+10
        last_probe = 'not attempted'
        while time.monotonic() < deadline:
            if any(process.poll() is not None for process in self.processes):
                self.fail(self.startup_diagnostics(last_probe))
            try:
                health = self.request('/health', timeout=.5)
                ready = self.request('/api/ready', timeout=.5)
                last_probe = f'health={health[0]}, API readiness={ready[0]}, body={ready[2]!r}'
                if health[0] == 200 and ready[0] == 200:
                    return
            except (OSError, http.client.HTTPException) as error:
                last_probe = f'{type(error).__name__}: {error}'
            time.sleep(.03)
        self.fail(self.startup_diagnostics(last_probe))

    def startup_diagnostics(self, last_probe):
        logs = os.pread(self.log.fileno(), 16384, 0).decode(errors='replace')
        processes = ', '.join(f'pid={process.pid} exit={process.poll()}' for process in self.processes)
        return (f'Development frontend/API failed to become ready: frontend={self.frontend_port}, '
                f'backend={self.backend_port}; {last_probe}; {processes}\n{logs}')

    def stop(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    def request(self, path, method='GET', data=None, headers=None, timeout=10):
        headers = dict(headers or {})
        if data is not None:
            data = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', self.frontend_port, timeout=timeout)
        try:
            connection.request(method, path, data, headers)
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            connection.close()

    def test_static_frontend_does_not_leak_files_and_has_no_spa_missing_fallback(self):
        status, headers, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT/'web/index.html').read_bytes())
        self.assertIn(('X-Frame-Options', 'DENY'), headers)
        for path in ['/app.js', '/i18n.js', '/locales.js', '/planning.js', '/productivity.js', '/styles.css', '/enterprise.js', '/enterprise.css', '/workflows.js', '/workflows.css']:
            self.assertEqual(self.request(path)[0], 200)
        for path in ['/missing.js', '/.env', '/src/server.c', '/data/cache.db', '/../Dockerfile']:
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request('/planning.js', method='HEAD')[2], b'')

    def test_authenticated_cookie_csrf_revision_idempotency_and_logout_roundtrip(self):
        self.assertEqual(self.request('/api/boards')[0], 401)
        self.assertEqual(self.request('/api/catalog')[0], 401)
        status, headers, body = self.request('/api/auth/setup', 'POST', {'name':'Proxy test', 'username':'proxy.test', 'password':'Proxy-test-password-2026!'}, {'Origin':self.origin})
        self.assertEqual(status, 201, body)
        session = json.loads(body)
        cookie = next(value for name,value in headers if name.lower() == 'set-cookie')
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        authenticated = {'Cookie':cookie.split(';', 1)[0], 'X-CSRF-Token':session['csrf'], 'Origin':self.origin}
        catalog_status, _, catalog_body = self.request('/api/catalog', headers=authenticated)
        self.assertEqual(catalog_status, 200, catalog_body)
        catalog = json.loads(catalog_body)
        self.assertIn('normal', catalog['priorities'])
        self.assertEqual({item['value'] for item in catalog['custom_field_types']}, {'text','number','date','boolean','select'})
        status, _, body = self.request('/api/boards', 'POST', {'name':'Proxy board'}, authenticated | {'Idempotency-Key':'frontend-roundtrip'})
        self.assertEqual(status, 201, body)
        created = json.loads(body)
        status, headers, body = self.request('/api/boards', 'POST', {'name':'Proxy board'}, authenticated | {'Idempotency-Key':'frontend-roundtrip'})
        self.assertEqual(status, 201, body)
        self.assertEqual(json.loads(body), created)
        self.assertIn(('Idempotency-Replayed', 'true'), headers)
        status, _, body = self.request(f'/api/boards/{created["id"]}', headers=authenticated)
        self.assertEqual(status, 200)
        board = json.loads(body)
        self.assertEqual(self.request(f'/api/boards/{created["id"]}', 'PATCH', {'name':'Changed'}, authenticated | {'If-Match':f'"{board["version"]}"'})[0], 200)
        self.assertEqual(self.request(f'/api/boards/{created["id"]}', 'PATCH', {'name':'Stale'}, authenticated | {'If-Match':f'"{board["version"]}"'})[0], 412)
        self.assertEqual(self.request('/api/boards', 'POST', {'name':'Blocked'}, authenticated | {'X-CSRF-Token':'wrong'})[0], 403)
        status, headers, _ = self.request('/api/auth/logout', 'POST', {}, authenticated)
        self.assertEqual(status, 200)
        self.assertTrue(any(name.lower() == 'set-cookie' and 'Max-Age=0' in value for name,value in headers))
        self.assertEqual(self.request('/api/boards', headers=authenticated)[0], 401)

    def test_request_body_limit_and_unavailable_backend(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.frontend_port, timeout=5)
        try:
            connection.putrequest('POST', '/api/boards')
            connection.putheader('Content-Length', str(2*1024*1024+1))
            connection.endheaders()
            self.assertEqual(connection.getresponse().status, 413)
        finally:
            connection.close()
        self.processes[0].terminate()
        self.processes[0].wait(timeout=5)
        self.assertEqual(self.request('/api/auth/session')[0], 502)
        self.assertEqual(self.request('/')[0], 200)

    def test_proxy_preserves_duplicate_cookies_and_opaque_request_response(self):
        self.processes[0].terminate()
        self.processes[0].wait(timeout=5)
        response_body = b'{"opaque":[true,0,"Caff\\u00e8"]}'
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_PATCH(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                self.server.captured = (self.path, dict(self.headers), body)
                self.send_response(202)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response_body)))
                self.send_header('Set-Cookie', 'one=1; HttpOnly')
                self.send_header('Set-Cookie', 'two=2; HttpOnly')
                self.send_header('X-Upstream-Probe', 'preserved')
                self.end_headers()
                self.wfile.write(response_body)
        upstream = DEV.LoopbackServer(('127.0.0.1', self.backend_port), Upstream)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        headers = {'Cookie':'one=1; two=2', 'Origin':self.origin, 'X-CSRF-Token':'opaque-csrf', 'If-Match':'"7"', 'Idempotency-Key':'opaque-key'}
        status, returned, body = self.request('/api/opaque?query=caff%C3%A8', 'PATCH', {'zero':0, 'false':False}, headers)
        self.assertEqual((status, body), (202, response_body))
        self.assertEqual([value for name,value in returned if name.lower() == 'set-cookie'], ['one=1; HttpOnly', 'two=2; HttpOnly'])
        self.assertIn(('X-Upstream-Probe', 'preserved'), returned)
        path, forwarded, raw = upstream.captured
        self.assertEqual(path, '/api/opaque?query=caff%C3%A8')
        self.assertEqual(raw, json.dumps({'zero':0, 'false':False}).encode())
        for name,value in headers.items():
            self.assertEqual(forwarded[name], value)


class LoopbackFrontendStartup(unittest.TestCase):
    def test_numeric_loopback_bind_does_not_depend_on_reverse_dns(self):
        with patch('socket.getfqdn', side_effect=AssertionError('Unexpected DNS lookup')):
            with DEV.LoopbackServer(('127.0.0.1', 0), DEV.Frontend) as server:
                self.assertEqual(server.server_name, '127.0.0.1')
                self.assertGreater(server.server_port, 0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                    try:
                        connection.request('GET', '/health')
                        response = connection.getresponse()
                        self.assertEqual((response.status, response.read()), (200, b'ok\n'))
                    finally:
                        connection.close()
                finally:
                    server.shutdown()
                    thread.join(timeout=2)
