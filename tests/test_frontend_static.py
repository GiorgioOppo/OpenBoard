"""Opt-in HTTP tests against an isolated, read-only frontend container.

OPENBOARD_FRONTEND_IMAGE=openboard-frontend:0.6.1 python3 -m unittest discover
-s tests -p test_frontend_static.py -v
The fixture starts and removes only its own container. No database is used.
"""
import http.client
import os
from pathlib import Path
import subprocess
import time
import unittest

IMAGE = os.environ.get('OPENBOARD_FRONTEND_IMAGE')
ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(IMAGE, 'Set OPENBOARD_FRONTEND_IMAGE for static-container HTTP tests')
class FrontendStatic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['docker', 'run', '--rm', '--detach', '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--publish', '127.0.0.1::8080',
            IMAGE], check=True, capture_output=True, text=True, timeout=30)
        cls.container = result.stdout.strip()
        cls.addClassCleanup(lambda: subprocess.run(['docker', 'stop', '--time', '5', cls.container],
            capture_output=True, timeout=15))
        port = subprocess.run(['docker', 'port', cls.container, '8080/tcp'], check=True,
            capture_output=True, text=True, timeout=10).stdout.strip()
        cls.port = int(port.rsplit(':', 1)[1])
        deadline = time.monotonic()+15
        while time.monotonic() < deadline:
            try:
                if cls.request('/health')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.05)
        raise RuntimeError('Static frontend did not become healthy')

    @classmethod
    def request(cls, path, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=5)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_health_index_assets_and_head(self):
        status, _, body = self.request('/health')
        self.assertEqual((status, body), (200, b'ok\n'))
        status, headers, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])
        self.assertEqual(body, (ROOT/'web/index.html').read_bytes())
        for name, mime in [('app.js', 'javascript'), ('i18n.js', 'javascript'), ('locales.js', 'javascript'), ('planning.js', 'javascript'),
                           ('enterprise.js', 'javascript'), ('enterprise.css', 'text/css'),
                           ('workflows.js', 'javascript'), ('workflows.css', 'text/css'),
                           ('productivity.js', 'javascript'), ('importers.js', 'javascript'), ('styles.css', 'text/css'),
                           ('favicon.svg', 'image/svg+xml')]:
            with self.subTest(asset=name):
                status, headers, body = self.request('/'+name)
                self.assertEqual(status, 200)
                self.assertIn(mime, headers['Content-Type'])
                self.assertEqual(body, (ROOT/'web'/name).read_bytes())
        self.assertEqual(self.request('/planning.js', 'HEAD')[2], b'')

    def test_unknown_assets_secrets_and_api_are_not_served(self):
        for path in ['/missing.js', '/missing', '/api/boards', '/api/auth/session',
                     '/.env', '/src/cloud.c', '/Dockerfile', '/web/', '/data/openboard.db']:
            with self.subTest(path=path):
                status, _, body = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b'<!doctype html>', body.lower())

    def test_security_headers_and_static_write_rejection(self):
        for path in ['/', '/planning.js', '/missing.js']:
            with self.subTest(path=path):
                _, headers, _ = self.request(path)
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(headers['X-Frame-Options'], 'DENY')
                self.assertIn("connect-src 'self'", headers['Content-Security-Policy'])
                self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
                self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertGreaterEqual(self.request('/app.js', 'POST')[0], 400)
