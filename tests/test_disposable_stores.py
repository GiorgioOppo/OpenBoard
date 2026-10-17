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
        with patch.object(stores_module, 'docker', side_effect=fake), patch.object(stores_module, 'free_port', side_effect=[55432, 57017]), \
                patch.object(stores_module.DisposableStores, '_wait_host') as host_ready:
            with stores_module.DisposableStores(publish=True) as stores:
                prefix = stores.prefix
                passwords = tuple(stores.variables.values())
                urls = stores.urls(host=True)
                self.assertIn('@127.0.0.1:', urls['OPENBOARD_POSTGRES_URL'])
                self.assertIn('@127.0.0.1:', urls['OPENBOARD_MONGODB_URI'])
                self.assertEqual(host_ready.call_args_list,
                                 [unittest.mock.call(stores.postgres, 55432), unittest.mock.call(stores.mongo, 57017)])
            self.assertTrue(calls[-1][0][:2] == ('network', 'rm'))
        network = next(arguments for arguments, _ in calls if arguments[:2] == ('network', 'create'))
        self.assertNotIn('--internal', network)
        probes = [arguments for arguments, _ in calls if arguments[0] == 'exec']
        postgres_probe = next(arguments for arguments in probes if 'psql ' in arguments[-1])
        self.assertIn('psql -h 127.0.0.1 -U openboard', postgres_probe[-1])
        mongo_probe = next(arguments for arguments in probes if 'mongosh' in arguments)
        self.assertEqual(mongo_probe[mongo_probe.index('--host') + 1], '127.0.0.1')
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
        self.assertIn('--internal', calls[0])

    def test_published_readiness_checks_loopback_and_retries_transport_only(self):
        stores = stores_module.DisposableStores()
        connected = unittest.mock.MagicMock()
        with patch.object(stores_module, 'docker', return_value=SimpleNamespace(stdout=b'running')), \
                patch.object(stores_module.socket, 'create_connection', side_effect=[ConnectionRefusedError(), connected]) as connect, \
                patch.object(stores_module.time, 'sleep'):
            stores._wait_host(stores.postgres, 55432)
        self.assertEqual(connect.call_count, 2)
        for call in connect.call_args_list:
            self.assertEqual(call.args, (('127.0.0.1', 55432),))
            self.assertLessEqual(call.kwargs['timeout'], 1)
        connected.__exit__.assert_called_once()

    def test_published_readiness_is_bounded_and_reports_sanitized_failure(self):
        stores = stores_module.DisposableStores()
        with patch.object(stores_module, 'docker', return_value=SimpleNamespace(stdout=b'running')), \
                patch.object(stores_module.socket, 'create_connection', side_effect=OSError('synthetic-private-detail')), \
                patch.object(stores_module.time, 'monotonic', side_effect=[0, 0, 0, 31, 31]), \
                patch.object(stores_module.time, 'sleep'):
            with self.assertRaises(backup_tools.BackupError) as caught:
                stores._wait_host(stores.postgres, 55432)
        self.assertIn('loopback port', str(caught.exception))
        self.assertNotIn('synthetic-private-detail', str(caught.exception))

    def test_published_readiness_fails_before_connect_if_container_exited(self):
        stores = stores_module.DisposableStores()
        with patch.object(stores_module, 'docker', return_value=SimpleNamespace(stdout=b'exited')), \
                patch.object(stores_module.socket, 'create_connection') as connect:
            with self.assertRaisesRegex(backup_tools.BackupError, 'stopped'):
                stores._wait_host(stores.postgres, 55432)
        connect.assert_not_called()

    def test_host_readiness_failure_cleans_all_fresh_resources(self):
        calls = []
        def fake(*arguments, **_):
            calls.append(arguments)
            return SimpleNamespace(returncode=0, stdout=b'running' if arguments[0] == 'inspect' else b'')
        with patch.object(stores_module, 'docker', side_effect=fake), \
                patch.object(stores_module, 'free_port', side_effect=[55432, 57017]), \
                patch.object(stores_module.DisposableStores, '_wait_host', side_effect=backup_tools.BackupError('Synthetic host route failure.')):
            with self.assertRaises(backup_tools.BackupError):
                with stores_module.DisposableStores(publish=True):
                    self.fail('An unreachable published route must not become ready')
        runs = [call for call in calls if call[0] == 'run']
        removed = [call[-1] for call in calls if call[0] == 'rm']
        self.assertEqual(set(removed), {call[call.index('--name') + 1] for call in runs})
        self.assertEqual(calls[-1][:2], ('network', 'rm'))

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
