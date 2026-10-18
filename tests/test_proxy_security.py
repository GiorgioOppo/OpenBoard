"""Opt-in tests of the real NPM -> C API client identity and abuse controls.

Set OPENBOARD_PROXY_IMAGE and OPENBOARD_APP_IMAGE (and optionally
OPENBOARD_FRONTEND_IMAGE). Only uniquely named containers, an unused Docker
subnet, temporary credentials and anonymous test volumes are used.
"""
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT/path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


BOOTSTRAP = module('proxy_bootstrap', 'scripts/bootstrap-local.py')
CHECK = module('proxy_deployment', 'scripts/check-deployment.py')


@unittest.skipUnless(os.environ.get('OPENBOARD_PROXY_IMAGE') and os.environ.get('OPENBOARD_APP_IMAGE'),
                     'Set OPENBOARD_PROXY_IMAGE and OPENBOARD_APP_IMAGE for isolated proxy tests')
class ProxySecurity(unittest.TestCase):
    @classmethod
    def docker(cls, *args, data=None, timeout=40):
        result = subprocess.run(['docker', *args], input=data, capture_output=True, timeout=timeout)
        if result.returncode:
            # Container logs, credentials and API payloads must stay private.
            raise RuntimeError('Disposable proxy fixture Docker operation failed: ' + args[0])
        return result.stdout

    @classmethod
    def setUpClass(cls):
        cls.prefix = 'openboard-proxy-test-' + uuid.uuid4().hex[:12]
        cls.network = cls.prefix + '-net'
        cls.containers = []
        cls.addClassCleanup(cls.cleanup)
        identifiers = cls.docker('network', 'ls', '--quiet').decode().split()
        networks = json.loads(cls.docker('network', 'inspect', *identifiers)) if identifiers else []
        used = [ipaddress.ip_network(item['Subnet']) for net in networks for item in (net.get('IPAM', {}).get('Config') or []) if item.get('Subnet')]
        options = [ipaddress.ip_network(f'172.29.{number}.0/24') for number in range(32, 250)]
        subnet = next((candidate for candidate in options if not any(candidate.overlaps(net) for net in used if net.version == 4)), None)
        if subnet is None:
            raise RuntimeError('No unused subnet for disposable proxy test')
        cls.base = str(subnet.network_address).rsplit('.', 1)[0]
        cls.docker('network', 'create', '--subnet', str(subnet), cls.network)
        cls.app = cls.start('app', os.environ['OPENBOARD_APP_IMAGE'], 3, [
            '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001,mode=0700',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--env', 'OPENBOARD_PUBLIC_URL=http://openboard.localhost',
            '--env', f'OPENBOARD_TRUSTED_PROXY={cls.base}.2'])
        cls.frontend = cls.start('frontend', os.environ.get('OPENBOARD_FRONTEND_IMAGE', 'openboard-frontend:0.6.1'), 4, [
            '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'])
        cls.proxy = cls.start('npm', os.environ['OPENBOARD_PROXY_IMAGE'], 2, [
            '--publish', '127.0.0.1::80', '--publish', '127.0.0.1::81',
            '--env', 'IP_RANGES_FETCH_ENABLED=false'])
        cls.admin_port = int(cls.docker('port', cls.proxy, '81/tcp').decode().strip().rsplit(':', 1)[1])
        cls.public_port = int(cls.docker('port', cls.proxy, '80/tcp').decode().strip().rsplit(':', 1)[1])
        cls.clients = [cls.start('client' + str(index), os.environ['OPENBOARD_APP_IMAGE'], 10 + index,
                      ['--entrypoint', '/bin/sleep'], ['600']) for index in range(2)]
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                if BOOTSTRAP.npm_transport(cls.admin_port)('GET', '/api/')[0] == 200 and cls.app_request('GET', '/api/auth/session')[0] == 200:
                    break
            except (OSError, RuntimeError, BOOTSTRAP.BootstrapError, http.client.HTTPException):
                pass
            time.sleep(.2)
        else:
            raise RuntimeError('Disposable proxy fixture did not become ready')
        folder = tempfile.TemporaryDirectory(prefix=cls.prefix)
        cls.addClassCleanup(folder.cleanup)
        cls.values = BOOTSTRAP.bootstrap(BOOTSTRAP.npm_transport(cls.admin_port), cls.app_request,
                                        Path(folder.name)/'.env.local-admin')
        # NPM acknowledges its API write before the asynchronous nginx reload.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if cls.curl(cls.clients[1], 'http://npm/api/auth/session')[0] == 200:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Disposable OpenBoard virtual host did not reload')

    @classmethod
    def start(cls, role, image, address, options=(), command=()):
        name = cls.prefix + '-' + role
        cls.containers.append(name)
        cls.docker('run', '--detach', '--name', name, '--network', cls.network,
                   '--ip', f'{cls.base}.{address}', '--network-alias', role, *options, image, *command)
        return name

    @classmethod
    def cleanup(cls):
        for name in reversed(cls.containers):
            subprocess.run(['docker', 'rm', '--force', '--volumes', name], capture_output=True, timeout=30)
        subprocess.run(['docker', 'network', 'rm', cls.network], capture_output=True, timeout=30)

    @classmethod
    def curl(cls, container, url, method='GET', payload=None, forged=False):
        args = ['exec', '-i', container, 'curl', '--silent', '--show-error', '--max-time', '15',
                '--request', method, '--header', 'Host: openboard.localhost',
                '--header', 'Origin: http://openboard.localhost', '--header', 'Content-Type: application/json',
                '--write-out', '\n%{http_code}']
        if forged:
            # Neither these public headers nor the NPM private address may reset a quota.
            args += ['--header', 'X-Real-IP: ' + secrets.choice(['127.0.0.1', '203.0.113.14', cls.base + '.2']),
                     '--header', 'X-Forwarded-For: ' + secrets.token_hex(5), '--header', 'Forwarded: for=127.0.0.1']
        if payload is not None:
            args += ['--data-binary', '@-']
        raw = cls.docker(*args, url, data=None if payload is None else json.dumps(payload).encode())
        body, status = raw.rsplit(b'\n', 1)
        return int(status), body

    @classmethod
    def app_request(cls, method, path, payload=None):
        status, body = cls.curl(cls.app, 'http://127.0.0.1:8080' + path, method, payload)
        return status, json.loads(body)

    def test_01_loaded_nginx_configuration_and_private_api(self):
        source = self.docker('exec', self.proxy, 'nginx', '-T').decode()
        CHECK.nginx_preflight({'origin': 'http://openboard.localhost', 'https': False}, source)
        for prefix in ('/api/', '/api/v1/'):
            status, body = self.curl(self.clients[1], 'http://npm' + prefix + 'boards')
            self.assertEqual(status, 401)
            self.assertIsInstance(json.loads(body), dict)
        status, body = self.curl(self.clients[1], 'http://npm/')
        self.assertEqual(status, 200)
        self.assertIn(b'OpenBoard', body)

    def test_02_edge_limits_ignore_forged_headers_and_isolate_clients(self):
        statuses, blocked = [], []
        for index in range(14):
            prefix = '/api/auth/' if index % 2 == 0 else '/api/v1/auth/'
            status, body = self.curl(self.clients[0], 'http://npm' + prefix + 'login', 'POST',
                                     {'username': 'invalid' + str(index), 'password': 'wrong-password'}, forged=True)
            statuses.append(status)
            if status == 429:
                blocked.append(body)
        self.assertIn(401, statuses)
        # An HTML 429 is generated by nginx before forwarding to the C backend.
        self.assertTrue(any(b'<html>' in body for body in blocked), statuses)
        self.assertTrue(all(status in (401, 429) for status in statuses), statuses)
        # All six exact routes share the same edge quota, so switching API
        # version or authentication action cannot reset it.
        for prefix in ('/api/auth/', '/api/v1/auth/'):
            for action in ('login', 'setup', 'password'):
                status, body = self.curl(self.clients[0], 'http://npm' + prefix + action,
                                         'POST', {}, forged=True)
                self.assertEqual(status, 429)
                self.assertIn(b'<html>', body)
        status, body = self.curl(self.clients[1], 'http://npm/api/v1/auth/login', 'POST',
                                 {'username': self.values['OPENBOARD_ADMIN_USERNAME'],
                                  'password': self.values['OPENBOARD_ADMIN_PASSWORD']}, forged=True)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['user']['role'], 'admin')
        self.assertEqual(self.curl(self.clients[0], 'http://npm/api/auth/session')[0], 200)

    def test_03_npm_login_is_bounded_without_blocking_other_clients_or_routes(self):
        statuses, failures = [], []
        for _ in range(11):
            status, body = self.curl(self.clients[0], 'http://npm:81/api/tokens', 'POST',
                                   {'identity': 'invalid@openboard.localhost', 'secret': 'wrong-password'}, forged=True)
            statuses.append(status)
            if status == 400:
                failures.append(body[:500].decode(errors='replace'))
        self.assertEqual(statuses[-1], 429, failures)
        self.assertTrue(all(status in (400, 401) for status in statuses[:10]), statuses)
        status, _ = self.curl(self.clients[1], 'http://npm:81/api/tokens', 'POST',
                               {'identity': self.values['NPM_ADMIN_EMAIL'], 'secret': self.values['NPM_ADMIN_PASSWORD']}, forged=True)
        self.assertEqual(status, 200)
        self.assertEqual(self.curl(self.clients[0], 'http://npm:81/api/')[0], 200)
        self.assertNotEqual(self.curl(self.clients[0], 'http://npm:81/api/tokens/2fa', 'POST', {})[0], 429)
