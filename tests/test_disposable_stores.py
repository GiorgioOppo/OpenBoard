"""Check isolation, secret-free arguments and cleanup without accessing Docker."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import backup_tools
import disposable_stores as stores_module


class DisposableIsolation(unittest.TestCase):
    def test_unique_resources_loopback_ports_and_no_existing_volumes(self):
        calls = []
        def fake(*arguments, **kwargs):
            calls.append((arguments, kwargs))
            return SimpleNamespace(returncode=0, stdout=b'running' if arguments[0] == 'inspect' else b'')
        with patch.object(stores_module, 'docker', side_effect=fake), patch.object(stores_module, 'free_port', side_effect=[55432, 57017]):
            with stores_module.DisposableStores(publish=True) as stores:
                prefix = stores.prefix
                passwords = tuple(stores.variables.values())
                urls = stores.urls(host=True)
                self.assertIn('@127.0.0.1:', urls['OPENBOARD_POSTGRES_URL'])
                self.assertIn('@127.0.0.1:', urls['OPENBOARD_MONGODB_URI'])
            self.assertTrue(calls[-1][0][:2] == ('network', 'rm'))
        runs = [arguments for arguments, _ in calls if arguments[0] == 'run']
        self.assertEqual(len(runs), 2)
        for arguments in runs:
            self.assertIn('--pull=never', arguments)
            self.assertIn('--detach', arguments)
            self.assertNotIn('--rm', arguments)  # Mongo outage must retain its new anonymous volume.
            self.assertNotIn('--volume', arguments)
            self.assertTrue(arguments[arguments.index('--name') + 1].startswith(prefix))
            self.assertTrue(arguments[arguments.index('--publish') + 1].startswith('127.0.0.1:'))
            self.assertNotIn('.env', ' '.join(arguments))
            for secret in passwords:
                self.assertNotIn(secret, ' '.join(arguments))
        removed = [arguments[-1] for arguments, _ in calls if arguments[0] == 'rm']
        self.assertEqual(set(removed), {prefix+'-pg', prefix+'-mongo'})

    def test_partial_start_failure_cleans_only_its_new_resources(self):
        calls = []
        def fake(*arguments, **_):
            calls.append(arguments)
            if arguments[0] == 'run':
                raise backup_tools.BackupError('Synthetic launch failure.')
            return SimpleNamespace(returncode=0, stdout=b'')
        with patch.object(stores_module, 'docker', side_effect=fake):
            with self.assertRaises(backup_tools.BackupError):
                with stores_module.DisposableStores() as stores:
                    self.fail('A failed store must not become usable')
        networks = [arguments[-1] for arguments in calls if arguments[:2] == ('network', 'create')]
        self.assertEqual(len(networks), 1)
        prefix = networks[0][:-len('-net')]
        self.assertIn(('rm', '--force', '--volumes', prefix+'-pg'), calls)
        self.assertEqual(calls[-1], ('network', 'rm', prefix+'-net'))

    def test_cold_cache_export_uses_second_container_and_no_host_mount(self):
        calls = []
        with tempfile.TemporaryDirectory(prefix='openboard-cold-recovery-test-') as folder:
            source, target = Path(folder)/'source', Path(folder)/'target'
            source.write_bytes(b'synthetic snapshot')
            def fake(*arguments, **kwargs):
                calls.append(arguments)
                output = kwargs.get('stdout')
                if output is not subprocess.PIPE and output is not None:
                    output.write(source.read_bytes())
                return SimpleNamespace(returncode=0, stdout=b'')
            with patch.object(stores_module, 'docker', side_effect=fake):
                stores = stores_module.DisposableStores()
                stores.restore_and_export(source, target)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            runs = [arguments for arguments in calls if arguments[0] == 'run']
            self.assertEqual(len(runs), 2)
            self.assertNotEqual(runs[0][runs[0].index('--name') + 1], runs[1][runs[1].index('--name') + 1])
            self.assertIn('cold-cache.db', runs[1][-1])
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            for arguments in runs:
                self.assertIn('--read-only', arguments)
                self.assertIn('--tmpfs', arguments)
                self.assertNotIn('--mount', arguments)
                self.assertNotIn('--publish', arguments)


class DeploymentSecretDiagnostics(unittest.TestCase):
    def test_child_diagnostics_remove_urls_and_files_without_reading_them(self):
        spec = importlib.util.spec_from_file_location('deployment_secret_diagnostics', ROOT/'scripts/check-deployment.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        compose = module.Compose(ROOT/'compose.yaml', Path('/nonexistent/synthetic.env'))
        with patch.object(compose, 'json', return_value={'auth_enabled': True}) as call:
            self.assertEqual(compose.diagnostics(), {'auth_enabled': True})
        command = call.call_args[0][0]
        for variable in ('OPENBOARD_POSTGRES_URL', 'OPENBOARD_MONGODB_URI',
                         'OPENBOARD_POSTGRES_URL_FILE', 'OPENBOARD_MONGODB_URI_FILE'):
            position = command.index(variable)
            self.assertEqual(command[position - 1], '-u')
        self.assertEqual(command[:4], ['exec', '-T', 'app', 'env'])
        self.assertEqual(command[-1], '--diagnostics')


if __name__ == '__main__':
    unittest.main()
