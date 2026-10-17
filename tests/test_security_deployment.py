"""Resolve deployment boundaries with dummy credentials, never the real .env."""
import json
import copy
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DOCKER = shutil.which('docker')
SPEC = importlib.util.spec_from_file_location('deployment_checks', ROOT/'scripts/check-deployment.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def fixture_config(public=False):
    return {'services': {
        'app': {'environment': {'OPENBOARD_PUBLIC_URL': 'https://board.example.test' if public else 'http://openboard.localhost',
                                'OPENBOARD_AUTH': 'true', 'OPENBOARD_NO_DEMO': 'true',
                                'OPENBOARD_TRUSTED_PROXY': '172.30.240.2'}},
        'frontend': {}, 'postgres': {}, 'mongo': {},
        'npm': {'ports': [{'target': target, 'published': str(target),
                          'host_ip': '0.0.0.0' if public and target != 81 else '127.0.0.1'}
                         for target in (80, 81, 443)],
                'networks': {'frontend': {'ipv4_address': '172.30.240.2'}}}},
        'networks': {'backend': {'internal': True},
                     'frontend': {'ipam': {'config': [{'subnet': '172.30.240.0/24', 'ip_range': '172.30.240.128/25'}]}}}}


def fixture_bindings(settings):
    return {**{name: {} for name in ('app', 'frontend', 'postgres', 'mongo')},
            'npm': {f'{target}/tcp': [{'HostIp': ip, 'HostPort': str(port)}]
                    for target, (ip, port) in settings['ports'].items()}}


AUTH = json.dumps({'enabled': True, 'setup_required': False, 'user': None, 'csrf': ''}).encode()


def fixture_nginx(host='openboard.localhost'):
    controls = '''proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        limit_conn openboard_api_clients 8;
        limit_conn openboard_api_total 32;
        proxy_pass http://$openboard_api;'''
    auth = '\n'.join(f'''location = /api/auth/{name} {{
        limit_req zone=openboard_auth burst=10 nodelay;
        {controls}
    }}''' for name in ('login', 'setup', 'password'))
    return f'''# configuration file /etc/nginx/nginx.conf:
events {{ worker_connections 1024; }}
http {{
    include /data/nginx/custom/http_top.conf;
    include /data/nginx/proxy_host/*.conf;
}}
# configuration file /data/nginx/custom/http_top.conf:
limit_req_zone $binary_remote_addr zone=openboard_auth:10m rate=5r/m;
limit_conn_zone $binary_remote_addr zone=openboard_api_clients:10m;
limit_conn_zone $server_name zone=openboard_api_total:1m;
limit_conn_status 429;
limit_req_status 429;
# configuration file /data/nginx/proxy_host/1.conf:
server {{
    listen 80;
    listen 443 ssl;
    server_name {host};
    set $openboard_api app:8080;
    location ^~ /api/ {{ {controls} }}
    {auth}
    location / {{ proxy_pass http://frontend:8080; }}
}}
'''


class DeploymentGuards(unittest.TestCase):
    def test_http_is_limited_to_local_names_and_unambiguous_loopback(self):
        for origin in ('http://localhost', 'http://openboard.localhost:8088', 'http://127.0.0.1', 'http://127.0.0.2:8090',
                       'https://board.example.test', 'https://board.example.test:8443'):
            with self.subTest(origin=origin):
                self.assertEqual(CHECK.public_origin(origin), origin)
        for origin in ('http://board.example.test', 'http://192.168.1.2', 'http://0.0.0.0', 'http://127.1',
                       'http://localhost.evil.test', 'http://localhost/', 'http://localhost?', 'http://localhost:',
                       'http://localhost#fragment', 'http://user:secret@localhost', 'http://@localhost',
                       'https://bad%host', 'https://-bad.example', 'https://bad..example', 'https://localhost:65536',
                       'https://localhost\\evil', 'https://localhost\n', 'HTTPS://localhost', 'http://[::1]'):
            with self.subTest(origin=origin):
                with self.assertRaises(ValueError):
                    CHECK.public_origin(origin)

    def test_publication_requires_external_https_and_matching_port(self):
        CHECK.publication('http://openboard.localhost:8088', '127.0.0.1', 8088, 443)
        CHECK.publication('https://board.example.test:8443', '0.0.0.0', 8080, 8443)
        for args in (('http://openboard.localhost', '0.0.0.0', 80, 443),
                     ('https://localhost', '0.0.0.0', 80, 443),
                     ('https://board.example.test', '0.0.0.0', 80, 8443),
                     ('http://openboard.localhost', '127.0.0.1', 8088, 443)):
            with self.subTest(args=args):
                with self.assertRaises(ValueError):
                    CHECK.publication(*args)

    def test_configuration_rejects_exposure_origin_auth_and_proxy_trust_mismatch(self):
        self.assertFalse(CHECK.configuration(fixture_config())['https'])
        self.assertTrue(CHECK.configuration(fixture_config(True))['https'])
        mutations = [
            lambda c: c['services']['npm']['ports'][1].update(host_ip='0.0.0.0'),
            lambda c: c['services']['npm']['ports'][0].update(host_ip='0.0.0.0'),
            lambda c: c['services']['app']['environment'].update(OPENBOARD_AUTH='false'),
            lambda c: c['services']['app']['environment'].update(OPENBOARD_NO_DEMO='false'),
            lambda c: c['services']['app'].update(ports=[{'target': 8080, 'published': '8080'}]),
            lambda c: c['services']['mongo'].update(network_mode='host'),
            lambda c: c['services']['npm'].update(network_mode='host'),
            lambda c: c['networks']['backend'].update(internal=False),
            lambda c: c['services']['app']['environment'].update(OPENBOARD_TRUSTED_PROXY='172.30.240.3'),
            lambda c: c['services']['npm']['networks']['frontend'].update(ipv4_address='172.30.241.2'),
            lambda c: c['services']['npm']['networks']['frontend'].update(ipv4_address='172.30.240.0'),
            lambda c: c['networks']['frontend']['ipam']['config'][0].update(ip_range='172.30.240.0/25'),
            lambda c: c['networks']['frontend']['ipam']['config'][0].update(ip_range='172.30.241.0/25'),
            lambda c: c['services']['npm']['ports'].append({'target': 82, 'published': '82'}),
            lambda c: c['services']['npm']['ports'].append({'target': 80, 'published': '8080'}),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                config = fixture_config()
                mutation(config)
                with self.assertRaises(CHECK.DeploymentError):
                    CHECK.configuration(config)

    def test_running_bindings_catch_old_deployment_and_direct_database_ports(self):
        settings = CHECK.configuration(fixture_config())
        expected = fixture_bindings(settings)
        CHECK.live_ports(settings, expected)
        for name, target in (('npm', '80/tcp'), ('mongo', '27017/tcp')):
            bindings = copy.deepcopy(expected)
            bindings[name][target] = [{'HostIp': '0.0.0.0', 'HostPort': '80'}]
            with self.subTest(name=name):
                with self.assertRaises(CHECK.DeploymentError):
                    CHECK.live_ports(settings, bindings)

    def test_nginx_parser_expands_loaded_includes_and_checks_selected_host(self):
        settings = CHECK.configuration(fixture_config())
        source = fixture_nginx()
        CHECK.nginx_preflight(settings, source)
        # Controls in an unrelated virtual host must never make an unsafe host pass.
        unrelated = source.replace('server_name openboard.localhost;', 'server_name other.example.test;')
        unrelated += '''# configuration file /data/nginx/proxy_host/2.conf:
server { listen 80; server_name openboard.localhost;
location ^~ /api/ { proxy_pass http://app:8080; } }
'''
        with self.assertRaises(CHECK.DeploymentError):
            CHECK.nginx_preflight(settings, unrelated)

    def test_nginx_controls_fail_closed_for_spoofed_ip_and_missing_limits(self):
        settings = CHECK.configuration(fixture_config())
        source = fixture_nginx()
        changes = (
            ('$remote_addr;', '$proxy_add_x_forwarded_for;'),
            ('limit_conn openboard_api_clients 8;', 'limit_conn openboard_api_clients 800;'),
            ('limit_conn openboard_api_total 32;', ''),
            ('rate=5r/m', 'rate=500r/m'),
            ('limit_req_status 429;', 'limit_req_status 503;'),
            ('limit_conn_status 429;', ''),
            ('location = /api/auth/login', 'location = /different'),
            ('location = /api/auth/password', 'location = /other'),
            ('limit_req zone=openboard_auth burst=10 nodelay;', '# limiter disabled'),
            ('limit_conn_zone $binary_remote_addr', 'limit_conn_zone $http_x_forwarded_for'),
            ('events {', 'set_real_ip_from 172.16.0.0/12; events {'),
            ('include /data/nginx/custom/http_top.conf;', '# missing include'),
        )
        for old, new in changes:
            with self.subTest(old=old):
                with self.assertRaises(CHECK.DeploymentError):
                    CHECK.nginx_preflight(settings, source.replace(old, new))

    def test_nginx_lexer_ignores_comments_and_handles_quoted_empty_values(self):
        self.assertEqual(CHECK.nginx_tokens('proxy_set_header Connection ""; # { ignored\nset $v "a;{b}";'),
                         ['proxy_set_header', 'Connection', '', ';', 'set', '$v', 'a;{b}', ';'])
        with self.assertRaises(CHECK.DeploymentError):
            CHECK.nginx_configuration('# configuration file /etc/nginx/nginx.conf:\nhttp { include missing.conf; }')
        with self.assertRaises(CHECK.DeploymentError):
            CHECK.nginx_configuration('# configuration file /etc/nginx/nginx.conf:\ninclude nginx.conf;')

    def ready(self, settings, backend=(200, AUTH), npm=(200, b'{"setup":true}'), origin=None, bindings=None, proxy=None, diagnostics=None,
              storage=(200, b'{"status":"ready"}')):
        calls = []
        def proxy_get(path, tls):
            calls.append((path, tls))
            if proxy is not None:
                return proxy(path, tls)
            if settings['https'] and not tls:
                return 301, b'', {'location': settings['origin'] + path}
            if path == '/':
                return 200, b'<html>OpenBoard</html>', {'content-type': 'text/html; charset=utf-8'}
            return 200, AUTH, {'content-type': 'application/json'}
        CHECK.readiness(settings, lambda path: storage if path == '/api/ready' else backend, proxy_get, lambda path: npm,
                        settings['origin'] if origin is None else origin,
                        fixture_bindings(settings) if bindings is None else bindings,
                        fixture_nginx(urlsplit(settings['origin']).hostname),
                        {'auth_enabled': True, 'trusted_proxy': settings['trusted_proxy']} if diagnostics is None else diagnostics)
        return calls

    def test_readiness_requires_both_admins_and_authenticated_api_routing(self):
        settings = CHECK.configuration(fixture_config())
        self.assertEqual(self.ready(settings), [('/', False), ('/api/auth/session', False)])
        cases = ({'backend': (200, b'{"enabled":true,"setup_required":true}')},
                 {'backend': (200, b'{"enabled":false,"setup_required":false}')},
                 {'backend': (200, b'{"enabled":true,"setup_required":false,"user":{"id":1}}')},
                 {'backend': (421, b'private invalid host details')},
                 {'npm': (200, b'{"setup":false}')}, {'npm': (200, b'[]')},
                 {'origin': 'https://other.example.test'},
                 {'diagnostics': {'auth_enabled': True, 'trusted_proxy': ''}},
                 {'storage': (503, b'{"status":"unavailable"}')},
                 {'storage': (200, b'{"status":"unavailable"}')},
                 {'proxy': lambda path, tls: (200, b'private wrong endpoint', {'content-type': 'text/plain'})})
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(CHECK.DeploymentError):
                    self.ready(settings, **case)

    def test_https_readiness_checks_exact_redirect_without_following_it(self):
        settings = CHECK.configuration(fixture_config(True))
        self.assertEqual(self.ready(settings), [('/', True), ('/api/auth/session', True), ('/api/auth/session', False)])
        def bad_redirect(path, tls):
            if not tls:
                return 301, b'', {'location': 'https://attacker.example.test' + path}
            if path == '/':
                return 200, b'OpenBoard', {'content-type': 'text/html'}
            return 200, AUTH, {}
        with self.assertRaises(CHECK.DeploymentError):
            self.ready(settings, proxy=bad_redirect)

    def test_backend_commands_and_error_messages_do_not_disclose_private_output(self):
        secret = 'never-print-private-password'
        compose = CHECK.Compose(ROOT/'compose.yaml', Path('/fake/private.env'))
        with patch.object(CHECK.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, secret.encode(), secret.encode())) as run:
            with self.assertRaises(CHECK.DeploymentError) as error:
                compose.run(['config', '--format', 'json'])
            self.assertNotIn(secret, str(error.exception))
            self.assertIn('--env-file', run.call_args.args[0])
        with patch.object(CHECK, 'Compose') as factory:
            factory.return_value.json.return_value = fixture_config()
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(CHECK.main(['--config-only', '--env-file', '/fake/private.env']), 0)
            self.assertIn('non verificata', out.getvalue())
            factory.return_value.run.assert_not_called()
            self.assertNotIn(secret, out.getvalue() + err.getvalue())

    def test_diagnostics_disables_only_cloud_for_readonly_child_not_live_storage(self):
        compose = CHECK.Compose(ROOT/'compose.yaml', Path('/fake/private.env'))
        result = {'auth_enabled': True, 'trusted_proxy': '172.30.240.2'}
        with patch.object(compose, 'json', return_value=result) as request:
            self.assertEqual(compose.diagnostics(), result)
            request.assert_called_once_with(['exec', '-T', 'app', 'env', '-u', 'OPENBOARD_POSTGRES_URL',
                                         '-u', 'OPENBOARD_MONGODB_URI', '-u', 'OPENBOARD_POSTGRES_URL_FILE',
                                         '-u', 'OPENBOARD_MONGODB_URI_FILE', '/usr/local/bin/openboard', '--diagnostics'])
        settings = CHECK.configuration(fixture_config())
        paths = []
        def backend(path):
            paths.append(path)
            return (200, b'{"status":"ready"}') if path == '/api/ready' else (200, AUTH)
        def proxy(path, tls):
            return (200, b'OpenBoard', {'content-type':'text/html'}) if path == '/' else (200, AUTH, {})
        CHECK.readiness(settings, backend, proxy, lambda path:(200,b'{"setup":true}'), settings['origin'],
                        fixture_bindings(settings), fixture_nginx(), result)
        self.assertEqual(paths, ['/api/ready', '/api/auth/session'])

    def test_tls_connects_only_to_loopback_but_verifies_public_hostname(self):
        with patch.object(CHECK.socket, 'create_connection') as connect, patch.object(CHECK.ssl, 'create_default_context') as context:
            context.return_value.wrap_socket.side_effect = CHECK.ssl.SSLCertVerificationError('private certificate details')
            with self.assertRaises(CHECK.DeploymentError) as error:
                CHECK.loopback_get(8443, '/', 'board.example.test:8443', 'board.example.test')
            connect.assert_called_once_with(('127.0.0.1', 8443), timeout=15)
            context.return_value.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='board.example.test')
            connect.return_value.close.assert_called_once()
            self.assertNotIn('private certificate details', str(error.exception))

    def test_setup_admin_reuses_origin_guard_and_does_not_read_real_env(self):
        spec = importlib.util.spec_from_file_location('setup_checks', ROOT/'scripts/setup-admin.py')
        setup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(setup)
        with patch.dict(os.environ, {'OPENBOARD_PUBLIC_URL': 'http://external.example.test'}):
            with self.assertRaises(ValueError):
                setup.public_url()
        with patch.dict(os.environ, {'OPENBOARD_PUBLIC_URL': 'https://board.example.test:8443'}):
            self.assertEqual(setup.public_url(), ('https://board.example.test:8443', 'board.example.test:8443'))


class PrivateEnvironment(unittest.TestCase):
    def test_unsafe_environment_is_rejected_before_creating_credentials(self):
        cases = (['--public-url', 'http://board.example.test'], ['--publish-ip', '0.0.0.0'],
                 ['--public-url', 'https://board.example.test:8443'],
                 ['--public-url', 'http://openboard.localhost', '--http-port', '8088'])
        with tempfile.TemporaryDirectory() as folder:
            for index, extra in enumerate(cases):
                target = Path(folder) / f'rejected-{index}.env'
                result = subprocess.run([sys.executable, str(ROOT/'scripts/init-env.py'), '--path', str(target), *extra],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(target.exists())

    def test_init_defaults_are_private_and_network_exposure_is_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / '.env'
            result = subprocess.run([sys.executable, str(ROOT/'scripts/init-env.py'),
                                     '--path', str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            values = dict(line.split('=', 1) for line in target.read_text().splitlines()
                          if line and not line.startswith('#'))
            self.assertEqual(values['OPENBOARD_PUBLISH_IP'], '127.0.0.1')
            secrets = [values[key] for key in ('POSTGRES_PASSWORD', 'POSTGRES_APP_PASSWORD',
                                              'MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD')]
            self.assertEqual(len(set(secrets)), 4)
            for secret in secrets:
                self.assertEqual(len(secret), 64)
                self.assertNotIn(secret, result.stdout + result.stderr)
            original = target.read_bytes()
            repeated = subprocess.run([sys.executable, str(ROOT/'scripts/init-env.py'),
                                       '--path', str(target), '--publish-ip', '0.0.0.0'],
                                      capture_output=True, text=True)
            self.assertNotEqual(repeated.returncode, 0)
            self.assertEqual(target.read_bytes(), original)
            public = Path(folder) / 'public.env'
            subprocess.run([sys.executable, str(ROOT/'scripts/init-env.py'), '--path', str(public),
                            '--publish-ip', '0.0.0.0', '--public-url', 'https://board.example.test'],
                           check=True, capture_output=True)
            self.assertIn('OPENBOARD_PUBLISH_IP=0.0.0.0\n', public.read_text())


@unittest.skipUnless(DOCKER, 'Docker Compose CLI needed to resolve deployment boundaries')
class ComposeBoundaries(unittest.TestCase):
    def configuration(self, **overrides):
        # Explicit --env-file prevents Compose from opening deployment secrets.
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('OPENBOARD_', 'POSTGRES_', 'MONGO_', 'COMPOSE_'))}
        env.update({key: '0' * 64 for key in ('POSTGRES_PASSWORD', 'POSTGRES_APP_PASSWORD',
                                             'MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD')})
        env.update(overrides)
        result = subprocess.run([DOCKER, 'compose', '--env-file', os.devnull,
                                 '--file', str(ROOT/'compose.yaml'), 'config', '--format', 'json'],
                                cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_default_ingress_is_loopback_and_databases_are_private(self):
        config = self.configuration()
        services = config['services']
        for name in ('app', 'frontend', 'postgres', 'mongo'):
            self.assertFalse(services[name].get('ports'), name)
        ports = services['npm']['ports']
        self.assertEqual({int(port['target']) for port in ports}, {80, 81, 443})
        self.assertTrue(all(port['host_ip'] == '127.0.0.1' for port in ports))
        self.assertTrue(config['networks']['backend']['internal'])
        self.assertEqual(services['app']['environment']['OPENBOARD_AUTH'], 'true')
        self.assertEqual(services['app']['environment']['OPENBOARD_NO_DEMO'], 'true')
        self.assertEqual(CHECK.configuration(config)['trusted_proxy'], '172.30.240.2')
        self.assertEqual(config['networks']['frontend']['ipam']['config'][0]['ip_range'], '172.30.240.128/25')
        for name in ('app', 'frontend'):
            self.assertTrue(services[name]['read_only'])
            self.assertNotIn(services[name]['user'].split(':')[0], ('0', 'root'))
            self.assertEqual(services[name]['cap_drop'], ['ALL'])
            self.assertIn('no-new-privileges:true', services[name]['security_opt'])
        self.assertFalse(services['frontend'].get('environment'))

    def test_custom_proxy_subnet_and_dynamic_pool_are_coherent(self):
        config = self.configuration(OPENBOARD_FRONTEND_SUBNET='10.90.0.0/24', OPENBOARD_FRONTEND_IP_RANGE='10.90.0.128/25',
                                    OPENBOARD_PROXY_IP='10.90.0.2')
        self.assertEqual(CHECK.configuration(config)['trusted_proxy'], '10.90.0.2')

    def test_explicit_public_ingress_never_publishes_admin_or_databases(self):
        config = self.configuration(OPENBOARD_PUBLISH_IP='0.0.0.0', OPENBOARD_HTTP_PORT='8088',
                                    OPENBOARD_HTTPS_PORT='8443', OPENBOARD_NPM_ADMIN_PORT='8181')
        ports = {int(port['target']): port for port in config['services']['npm']['ports']}
        self.assertEqual(ports[80]['host_ip'], '0.0.0.0')
        self.assertEqual(str(ports[80]['published']), '8088')
        self.assertEqual(ports[443]['host_ip'], '0.0.0.0')
        self.assertEqual(ports[81]['host_ip'], '127.0.0.1')
        self.assertEqual(str(ports[81]['published']), '8181')
        for name in ('app', 'frontend', 'postgres', 'mongo'):
            self.assertFalse(config['services'][name].get('ports'), name)


if __name__ == '__main__':
    unittest.main()
