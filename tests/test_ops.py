"""Operational commands, configuration, metrics and HTTP boundaries."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import unittest

import test_transport
from test_transport import BINARY, ROOT


class OperationsTests(unittest.TestCase):
    setUp = test_transport.TransportTests.setUp
    start = test_transport.TransportTests.start
    stop = test_transport.TransportTests.stop
    request = test_transport.TransportTests.request

    def command(self, *args, env=None):
        return subprocess.run([str(BINARY), *args], capture_output=True, timeout=8, env=env)

    def test_environment_configuration_and_cli_precedence(self):
        env = {k:v for k,v in os.environ.items() if not k.startswith('OPENBOARD_')}
        env.update(OPENBOARD_WORKERS='3', OPENBOARD_AUTH='true', OPENBOARD_BUSY_TIMEOUT='1200',
                   OPENBOARD_BODY_LIMIT='8192', OPENBOARD_DB=str(Path(self.temp.name)/'missing.db'),
                   OPENBOARD_TRUSTED_PROXY='192.0.2.1')
        result = self.command('--diagnostics', '--workers', '2', '--trusted-proxy','192.0.2.2',env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['workers'], 2)
        self.assertEqual(data['busy_timeout_ms'], 1200)
        self.assertEqual(data['body_limit'], 8192)
        self.assertTrue(data['auth_enabled'])
        self.assertEqual(data['trusted_proxy'],'192.0.2.2')
        self.assertEqual(json.loads(self.command('--diagnostics',env=env).stdout)['trusted_proxy'],'192.0.2.1')
        self.assertEqual(data['schema_version'], -1)
        self.assertFalse(Path(env['OPENBOARD_DB']).exists())
        env['OPENBOARD_AUTH'] = 'maybe'
        self.assertNotEqual(self.command('--diagnostics', env=env).returncode, 0)

    def test_trusted_proxy_environment_rejects_ambiguous_or_broad_values(self):
        env={k:v for k,v in os.environ.items() if not k.startswith('OPENBOARD_')}
        env['OPENBOARD_TRUSTED_PROXY']=''
        result=self.command('--diagnostics',env=env)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['trusted_proxy'],'')
        for value in ('*','localhost','0.0.0.0/0','192.0.2.1,192.0.2.2','192.0.2.1:8080','0.0.0.0'):
            with self.subTest(value=value):
                env['OPENBOARD_TRUSTED_PROXY']=value
                self.assertNotEqual(self.command('--diagnostics',env=env).returncode,0)

    def test_configured_body_limit_encoding_and_request_id(self):
        self.stop(); self.start('--body-limit', '4096')
        status, headers, _ = self.request('GET', '/api/health', headers={'X-Request-ID':'qa.request-200:1'})
        self.assertEqual(status, 200); self.assertEqual(headers['X-Request-ID'], 'qa.request-200:1')
        self.assertEqual(self.request('GET','/api/health',headers={'X-Request-ID':'bad id'})[0],400)
        self.assertEqual(self.request('POST','/api/boards',headers={'Content-Type':'application/json','Content-Encoding':'gzip'})[0],415)
        self.assertEqual(self.request('POST','/api/boards',headers={'Content-Type':'application/json','Content-Length':'5000'})[0],413)
        self.assertEqual(self.request('GET','/api/ready')[0],200)

    def test_metrics_counters_and_private_cache(self):
        self.assertEqual(self.request('GET','/api/missing')[0],404)
        status, headers, body = self.request('GET','/api/metrics')
        self.assertEqual(status,200)
        self.assertIn('text/plain',headers['Content-Type'])
        self.assertEqual(headers['Cache-Control'],'no-store')
        values = dict(line.split() for line in body.decode().splitlines() if line and not line.startswith('#'))
        self.assertGreaterEqual(int(values['openboard_http_requests_total']),3)
        self.assertEqual(int(values['openboard_http_errors_total']),1)
        self.assertGreaterEqual(int(values['openboard_http_active']),1)
        # Each completed 404 must already be visible to the next HTTP client,
        # even when another worker handles metrics before error-request cleanup.
        # Exact totals also catch accidentally counting the same response twice.
        for expected in range(2,21):
            with self.subTest(completed_errors=expected):
                self.assertEqual(self.request('GET','/api/missing')[0],404)
                status, _, body = self.request('GET','/api/metrics')
                self.assertEqual(status,200)
                values = dict(line.split() for line in body.decode().splitlines()
                              if line and not line.startswith('#'))
                self.assertEqual(int(values['openboard_http_errors_total']),expected)

    def test_metrics_require_global_admin_with_accounts(self):
        self.stop(); self.start('--auth')
        self.assertEqual(self.request('GET','/api/metrics')[0],401)
        status, headers, body = self.request('POST','/api/auth/setup',json.dumps({
            'name':'Ops admin','username':'ops.admin','password':'Ops-test-password!'}),{'Content-Type':'application/json'})
        self.assertEqual(status,201)
        session=json.loads(body)
        admin={'Content-Type':'application/json','Cookie':headers['Set-Cookie'].split(';')[0],'X-CSRF-Token':session['csrf']}
        self.assertEqual(self.request('GET','/api/metrics',headers=admin)[0],200)
        status, _, _ = self.request('POST','/api/users',json.dumps({
            'name':'Member','username':'ops.member','password':'Ops-member-password!','role':'member'}),admin)
        self.assertEqual(status,201)
        _, member_headers, _ = self.request('POST','/api/auth/login',json.dumps({
            'username':'ops.member','password':'Ops-member-password!'}),{'Content-Type':'application/json'})
        member={'Cookie':member_headers['Set-Cookie'].split(';')[0]}
        self.assertEqual(self.request('GET','/api/metrics',headers=member)[0],403)

    def test_static_symlinks_and_embedded_nul_are_rejected(self):
        self.stop()
        assets=Path(self.temp.name)/'assets'; assets.mkdir()
        secret=Path(self.temp.name)/'secret'; secret.write_text('private-data')
        (assets/'leak.js').symlink_to(secret)
        (assets/'bad.js').write_bytes(b'hello\0hidden')
        (assets/'index.html').write_text('<h1>Good</h1>')
        self.start()
        status, _, body=self.request('GET','/leak.js')
        self.assertEqual(status,404);self.assertNotIn(b'private-data',body)
        self.assertEqual(self.request('GET','/bad.js')[0],404)
        self.assertEqual(self.request('GET','/')[0],404)

    def test_integrity_diagnostics_and_checkpoint_without_migration(self):
        old=Path(self.temp.name)/'old.db'
        with sqlite3.connect(old) as connection:
            connection.executescript('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES("keep"); PRAGMA user_version=999;')
        self.assertEqual(self.command('--db',str(old),'--integrity-check').returncode,0)
        result=self.command('--db',str(old),'--diagnostics')
        self.assertEqual(json.loads(result.stdout)['schema_version'],999)
        with sqlite3.connect(old) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0],999)
            self.assertEqual(connection.execute('SELECT value FROM sentinel').fetchone()[0],'keep')
        self.assertEqual(self.command('--db',str(Path(self.temp.name)/'test.db'),'--checkpoint').returncode,0)
        corrupt=Path(self.temp.name)/'corrupt.db';corrupt.write_bytes(b'not a database')
        self.assertNotEqual(self.command('--db',str(corrupt),'--integrity-check').returncode,0)
        missing=Path(self.temp.name)/'never.db'
        self.assertNotEqual(self.command('--db',str(missing),'--checkpoint').returncode,0)
        self.assertFalse(missing.exists())

    def test_install_separates_backend_from_frontend_assets(self):
        stage=Path(self.temp.name)/'stage'
        result=subprocess.run(['make','install',f'DESTDIR={stage}','PREFIX=/opt/openboard'],cwd=ROOT,capture_output=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue((stage/'opt/openboard/bin/openboard').is_file())
        self.assertFalse((stage/'opt/openboard/share/openboard').exists())
        result=subprocess.run(['make','install-frontend',f'DESTDIR={stage}','PREFIX=/opt/openboard'],cwd=ROOT,capture_output=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        for asset in (ROOT/'web').iterdir():
            if asset.suffix in ('.js','.css','.html','.svg'):
                self.assertEqual((stage/'opt/openboard/share/openboard'/asset.name).read_bytes(),asset.read_bytes())

    def test_maintenance_and_configuration_reject_invalid_combinations(self):
        for args in [('--busy-timeout','0'),('--busy-timeout','60001'),('--body-limit','4095'),
                     ('--body-limit','2097153'),('--checkpoint','--integrity-check'),('--diagnostics','--backup','out.db')]:
            with self.subTest(args=args): self.assertNotEqual(self.command(*args).returncode,0)


if __name__=='__main__': unittest.main()
