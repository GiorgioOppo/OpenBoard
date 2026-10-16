"""Real HTTP transport regressions; each instance uses a disposable SQLite DB."""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('OPENBOARD_BINARY', ROOT / 'build/openboard'))

class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openboard-transport-')
        self.addCleanup(self.temp.cleanup)
        self.log = (Path(self.temp.name) / 'server.log').open('w+b')
        self.addCleanup(self.log.close)
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self, *options, local=True):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); self.port = s.getsockname()[1]
        self.process = subprocess.Popen([str(BINARY), '--port', str(self.port), '--db', str(Path(self.temp.name)/'test.db'), '--quiet', *(['--no-auth'] if local else []), *options], stdout=self.log, stderr=self.log)
        deadline = time.monotonic()+5
        while time.monotonic()<deadline:
            if self.process.poll() is not None:
                self.fail('Server startup failed: '+(Path(self.temp.name)/'server.log').read_text())
            try:
                if self.request('GET','/api/health')[0] == 200: return
            except (OSError, http.client.HTTPException): pass
            time.sleep(.025)
        self.fail('Server startup timeout')

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=3)
        self.process = None

    def request(self, method, path, body=None, headers=None):
        c=http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r=c.getresponse(); return r.status, dict(r.getheaders()), r.read()
        finally: c.close()

    def test_health_readiness_version_head_and_request_ids(self):
        status,h,b=self.request('GET','/api/ready')
        self.assertEqual(status,200);self.assertEqual(json.loads(b)['status'],'ready')
        status,v,b=self.request('GET','/api/version')
        version=json.loads(b)
        self.assertEqual(version['version'],'0.4.0');self.assertGreaterEqual(version['workers'],2)
        self.assertNotEqual(h['X-Request-ID'],v['X-Request-ID'])
        status,h,b=self.request('HEAD','/api/health')
        self.assertEqual(status,200);self.assertEqual(b,b'');self.assertGreater(int(h['Content-Length']),0)
        self.assertEqual(h['Cache-Control'],'no-store')

    def test_backend_has_no_static_routes_and_auth_is_default(self):
        self.stop(); self.start(local=False)
        self.assertEqual(self.request('GET','/api/boards')[0],401)
        self.assertEqual(self.request('POST','/api/boards', '{}', {'Content-Type':'application/json'})[0],401)
        self.assertTrue(json.loads(self.request('GET','/api/version')[2])['auth_enabled'])
        for path in ('/','/app.js','/styles.css','/index.html'):
            status, headers, body = self.request('GET',path)
            self.assertEqual(status,404); self.assertIn('application/json',headers['Content-Type'])
            status, headers, body = self.request('HEAD',path)
            self.assertEqual(status,404); self.assertEqual(body,b'')

    def test_partial_client_does_not_block_and_has_total_deadline(self):
        with socket.create_connection(('127.0.0.1',self.port),timeout=3) as slow:
            slow.sendall(b'GET /api/health HTTP/1.1\r\nHost: ')
            start=time.monotonic()
            self.assertEqual(self.request('GET','/api/health')[0],200)
            self.assertLess(time.monotonic()-start,1.0)
            for _ in range(5):
                time.sleep(1.05)
                try: slow.sendall(b'x')
                except (BrokenPipeError,ConnectionResetError): break
            slow.settimeout(2)
            try:
                result=slow.recv(8192)
                self.assertIn(b'408 Request Timeout',result)
            except ConnectionResetError:
                # Linux may reset after sending an error with unread client bytes.
                pass
            self.assertLess(time.monotonic()-start,7.5)
        self.assertEqual(self.request('GET','/api/ready')[0],200)

    def test_duplicate_security_headers_are_rejected(self):
        for name,value in [('Cookie','a=b'),('X-CSRF-Token','abc'),('If-Match','"1"'),('Idempotency-Key','repeat'),('If-None-Match','"x"')]:
            with self.subTest(header=name), socket.create_connection(('127.0.0.1',self.port),timeout=3) as c:
                c.sendall((f'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n{name}: {value}\r\n{name}: {value}\r\n\r\n').encode())
                r=http.client.HTTPResponse(c)
                try: r.begin();self.assertEqual(r.status,400);r.read()
                finally: r.close()

    def test_public_https_origin_configuration(self):
        self.stop();self.start('--public-url','https://board.example.test')
        body=json.dumps({'name':'HTTPS proxy board'})
        headers={'Content-Type':'application/json','Host':'board.example.test','Origin':'https://board.example.test'}
        self.assertEqual(self.request('POST','/api/boards',body,headers)[0],201)
        headers['Origin']='https://foreign.example.test'
        self.assertEqual(self.request('POST','/api/boards',body,headers)[0],403)
        self.assertEqual(self.request('GET','/api/health',headers={'Host':'attacker.test'})[0],403)

    def test_bounded_queue_overload_recovers(self):
        self.stop();self.start('--workers','2')
        sockets=[]
        try:
            for _ in range(2):
                c=socket.create_connection(('127.0.0.1',self.port),timeout=2);c.sendall(b'GET / HTTP/1.1\r\n');sockets.append(c)
            time.sleep(.1)
            for _ in range(64):
                sockets.append(socket.create_connection(('127.0.0.1',self.port),timeout=2))
            time.sleep(.1)
            with socket.create_connection(('127.0.0.1',self.port),timeout=2) as extra:
                r=http.client.HTTPResponse(extra)
                try:
                    r.begin();self.assertEqual(r.status,503);self.assertIn('occupato',json.loads(r.read())['error'])
                finally:r.close()
        finally:
            for c in sockets:c.close()
        self.assertEqual(self.request('GET','/api/ready')[0],200)

    def test_invalid_cli_bounds(self):
        for args in [('--workers','0'),('--workers','33'),('--port','65536'),('--public-url','https://host/path'),('--bind','192.0.2.1'),('--bind','localhost'),('--bind','0.0.0.0','--no-auth'),('--web-root','web')]:
            with self.subTest(args=args):
                r=subprocess.run([str(BINARY),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3)
                self.assertNotEqual(r.returncode,0)

if __name__=='__main__': unittest.main()
