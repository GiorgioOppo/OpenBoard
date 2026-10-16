"""Resolve deployment boundaries with dummy credentials, never the real .env."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCKER = shutil.which('docker')


class PrivateEnvironment(unittest.TestCase):
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
        for name in ('app', 'frontend'):
            self.assertTrue(services[name]['read_only'])
            self.assertNotIn(services[name]['user'].split(':')[0], ('0', 'root'))
            self.assertEqual(services[name]['cap_drop'], ['ALL'])
            self.assertIn('no-new-privileges:true', services[name]['security_opt'])
        self.assertFalse(services['frontend'].get('environment'))

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
