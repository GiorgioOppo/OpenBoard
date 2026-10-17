"""Operational backup tests use synthetic local files and mocked Compose only."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import backup_tools as tools


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BACKUP = load('backup_operations', 'backup.py')
SCHEDULE = load('backup_schedule', 'backup-schedule.py')
RESTORE = load('restore_check', 'restore-check.py')


def database(path):
    connection = sqlite3.connect(path)
    connection.executescript('''
PRAGMA user_version=7;
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL);
CREATE TABLE boards(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE cards(id INTEGER PRIMARY KEY, board_id INTEGER REFERENCES boards(id), title TEXT, details TEXT);
INSERT INTO users VALUES(1,'synthetic.admin');
INSERT INTO boards VALUES(1,'Synthetic recovery 日本語');
INSERT INTO cards VALUES(1,1,'Unicode Español','{"budget":0,"urgent":false,"items":[null,"原文"]}');
''')
    connection.commit()
    connection.close()


def proxy_archive(path, folder):
    directory = folder/'proxy-data'
    directory.mkdir()
    connection = sqlite3.connect(directory/'database.sqlite')
    connection.executescript('CREATE TABLE settings(name TEXT); INSERT INTO settings VALUES("synthetic");')
    connection.close()
    with tarfile.open(path, 'w:gz') as bundle:
        bundle.add(directory/'database.sqlite', arcname='data/database.sqlite')
        value = b'# Synthetic NPM configuration\n'
        member = tarfile.TarInfo('data/nginx/proxy_host/1.conf')
        member.size = len(value)
        bundle.addfile(member, io.BytesIO(value))


class FakeCompose:
    def __init__(self, snapshot, proxy=None, fail=False):
        self.snapshot = snapshot
        self.proxy = proxy
        self.fail = fail
        self.calls = []

    def run(self, *arguments, stdout=subprocess.PIPE, **_):
        self.calls.append(arguments)
        if arguments[:3] == ('ps', '--status', 'running'):
            return SimpleNamespace(stdout=b'app\nnpm\nfrontend\n')
        if arguments[0] == 'exec' and 'cat' in arguments:
            if self.fail:
                raise tools.BackupError('Synthetic failure.')
            stdout.write(self.snapshot.read_bytes())
        if arguments[0] == 'run':
            if 'app' in arguments:
                if self.fail:
                    raise tools.BackupError('Synthetic failure.')
                stdout.write(self.snapshot.read_bytes())
            elif 'npm' in arguments:
                stdout.write(self.proxy.read_bytes())
        return SimpleNamespace(stdout=b'')


class BackupIntegrity(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='openboard-backup-test-')
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.source = self.folder/'source.sqlite3'
        database(self.source)

    def test_verified_private_snapshot_manifest_and_roundtrip(self):
        destination = self.folder/'backup.sqlite3'
        result = BACKUP.create_backup(destination, FakeCompose(self.source))
        self.assertEqual(result['snapshot']['schema_version'], 7)
        self.assertEqual(result['snapshot']['table_rows']['cards'], 1)
        self.assertEqual(result['sha256'], tools.sha256(destination))
        for path in (destination, tools.manifest_path(destination)):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with tools.prepared_snapshot(destination) as (snapshot, proxy):
            self.assertEqual(tools.logical_fingerprint(snapshot), tools.logical_fingerprint(self.source))
            self.assertIsNone(proxy)
        self.assertEqual(len(list(self.folder.glob('.openboard-backup-*'))), 0)

    def test_non_database_and_foreign_key_failure_never_publish(self):
        self.source.write_bytes(b'not a snapshot')
        output = self.folder/'bad.sqlite3'
        with self.assertRaises(tools.BackupError):
            BACKUP.create_backup(output, FakeCompose(self.source))
        self.assertFalse(output.exists())
        self.source.unlink()
        database(self.source)
        with sqlite3.connect(self.source) as connection:
            connection.execute('INSERT INTO cards VALUES(2,999,"orphan","{}")')
        with self.assertRaises(tools.BackupError):
            BACKUP.create_backup(output, FakeCompose(self.source))
        self.assertFalse(output.exists())

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'FIFO checks require POSIX')
    def test_fifo_inputs_fail_without_waiting_for_a_writer(self):
        fifo = self.folder/'not-a-regular-file'
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(tools.BackupError):
            tools.regular_file(fifo)
        with self.assertRaises(tools.BackupError):
            tools.regular_file(fifo, private=True)
        with self.assertRaises(tools.BackupError):
            tools.sqlite_integrity(fifo)

    def test_existing_backup_and_manifest_are_never_overwritten(self):
        output = self.folder/'backup.sqlite3'
        output.write_bytes(b'existing')
        with self.assertRaises(tools.BackupError):
            BACKUP.create_backup(output, FakeCompose(self.source))
        self.assertEqual(output.read_bytes(), b'existing')
        output.unlink()
        tools.manifest_path(output).write_text('{}')
        with self.assertRaises(tools.BackupError):
            BACKUP.create_backup(output, FakeCompose(self.source))
        self.assertFalse(output.exists())

    def test_corrupt_artifact_and_wrong_snapshot_manifest_fail(self):
        output = self.folder/'backup.sqlite3'
        BACKUP.create_backup(output, FakeCompose(self.source))
        output.write_bytes(b'corrupt')
        with self.assertRaises(tools.BackupError):
            tools.verify_manifest(output)
        output.unlink()
        tools.manifest_path(output).unlink()
        BACKUP.create_backup(output, FakeCompose(self.source))
        sidecar = tools.manifest_path(output)
        metadata = json.loads(sidecar.read_text())
        metadata['snapshot']['table_rows']['cards'] = 9
        sidecar.write_text(json.dumps(metadata))
        with self.assertRaises(tools.BackupError):
            with tools.prepared_snapshot(output):
                pass

    def test_retention_only_prunes_verified_complete_pairs(self):
        for index in range(3):
            path = self.folder/f'backup-{index}.sqlite3'
            BACKUP.create_backup(path, FakeCompose(self.source))
            sidecar = tools.manifest_path(path)
            metadata = json.loads(sidecar.read_text())
            metadata['created_at'] = f'2026-10-{14+index}T00:00:00+00:00'
            sidecar.write_text(json.dumps(metadata))
        invalid = self.folder/'unverified.sqlite3'
        invalid.write_bytes(b'leave this alone')
        corrupt = self.folder/'corrupt.sqlite3'
        BACKUP.create_backup(corrupt, FakeCompose(self.source))
        corrupt.write_bytes(b'damaged')
        self.assertEqual(tools.retain(self.folder, 1), 2)
        self.assertTrue((self.folder/'backup-2.sqlite3').exists())
        self.assertTrue(invalid.exists())
        self.assertTrue(corrupt.exists())
        self.assertTrue(tools.manifest_path(corrupt).exists())
        with self.assertRaises(tools.BackupError):
            tools.retain(self.folder, 0)

    def test_scheduler_records_sanitized_failure_and_preserves_last_success(self):
        arguments = SimpleNamespace(directory=self.folder, encrypt_to=self.folder/'public.pem',
                                    include_proxy=False, compose_file=None, env_file=None,
                                    project_name=None, timeout=30, keep=2)
        secret = 'synthetic-error-do-not-print'
        with patch.object(SCHEDULE, 'run_process', return_value=SimpleNamespace(returncode=0)), patch.object(SCHEDULE, 'retain', return_value=0):
            self.assertTrue(SCHEDULE.run_backup(arguments))
        status_path = self.folder/'backup-status.json'
        previous = json.loads(status_path.read_text())['last_success_at']
        with patch.object(SCHEDULE, 'run_process', side_effect=subprocess.TimeoutExpired([secret], 30)):
            self.assertFalse(SCHEDULE.run_backup(arguments))
        text = status_path.read_text()
        self.assertNotIn(secret, text)
        result = json.loads(text)
        self.assertEqual(result['last_success_at'], previous)
        self.assertEqual(result['error'], 'backup_or_retention_failed')
        self.assertEqual(status_path.stat().st_mode & 0o777, 0o600)

    def test_proxy_archive_rejects_traversal_symlinks_devices_and_invalid_sqlite(self):
        valid = self.folder/'proxy.tar.gz'
        proxy_archive(valid, self.folder)
        tools.verify_proxy_archive(valid)
        for kind in ('traversal', 'symlink', 'device', 'invalid_sqlite'):
            with self.subTest(kind=kind):
                path = self.folder/f'{kind}.tar.gz'
                with tarfile.open(path, 'w:gz') as bundle:
                    member = tarfile.TarInfo('data/database.sqlite')
                    if kind == 'traversal':
                        member.name = '../../outside'
                    if kind == 'symlink':
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/etc/shadow'
                    elif kind == 'device':
                        member.type = tarfile.CHRTYPE
                    else:
                        member.size = 3
                    bundle.addfile(member, io.BytesIO(b'bad') if member.isfile() else None)
                with self.assertRaises(tools.BackupError):
                    tools.verify_proxy_archive(path)

    def test_recovery_compares_migrated_copy_not_the_original_legacy_schema(self):
        output = self.folder/'legacy.sqlite3'
        BACKUP.create_backup(output, FakeCompose(self.source))
        class MigratingStores:
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def migrate_snapshot(inner, source, expected, _):
                shutil.copyfile(source, expected)
                with sqlite3.connect(expected) as connection:
                    connection.executescript('PRAGMA user_version=8; CREATE TABLE migration_added(id INTEGER);')
            def restore_and_export(inner, source, restored, _):
                self.assertEqual(tools.sqlite_integrity(source)['schema_version'], 8)
                shutil.copyfile(source, restored)
        with patch.object(RESTORE, 'DisposableStores', MigratingStores):
            self.assertTrue(RESTORE.check_recovery(output))
        self.assertEqual(tools.sqlite_integrity(output)['schema_version'], 7)

    def test_installation_failure_restarts_only_previously_running_services(self):
        compose = FakeCompose(self.source, fail=True)
        with self.assertRaises(tools.BackupError):
            BACKUP.installation_payload(compose, self.folder)
        self.assertIn(('stop', 'app', 'npm'), compose.calls)
        self.assertEqual(compose.calls[-1], ('start', 'app', 'npm'))
        output = self.folder/'installation.cms'
        with self.assertRaises(tools.BackupError):
            BACKUP.create_backup(output, compose, include_proxy=True)
        self.assertFalse(output.exists())


@unittest.skipUnless(shutil.which(os.environ.get('OPENBOARD_OPENSSL', 'openssl')), 'OpenSSL is required for CMS encryption checks')
class EncryptedBackups(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='openboard-backup-crypto-test-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.folder = Path(cls.directory.name)
        cls.certificate, cls.key = tools.generate_keys(cls.folder/'keys')

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='openboard-backup-payload-')
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.source = self.folder/'source.sqlite3'
        database(self.source)

    def test_real_authenticated_encryption_and_wrong_key_permissions(self):
        output = self.folder/'encrypted.cms'
        metadata = BACKUP.create_backup(output, FakeCompose(self.source), self.certificate)
        self.assertEqual(metadata['encryption'], tools.ENCRYPTION)
        self.assertNotIn(b'Synthetic recovery', output.read_bytes())
        with tools.prepared_snapshot(output, self.key) as (snapshot, _):
            self.assertEqual(tools.logical_fingerprint(snapshot), tools.logical_fingerprint(self.source))
        with self.assertRaises(tools.BackupError):
            with tools.prepared_snapshot(output):
                pass
        private_copy = self.folder/'wide-key.pem'
        private_copy.write_bytes(self.key.read_bytes())
        os.chmod(private_copy, 0o644)
        with self.assertRaises(tools.BackupError):
            with tools.prepared_snapshot(output, private_copy):
                pass

    def test_ciphertext_tampering_fails_even_if_sidecar_checksum_is_changed(self):
        output = self.folder/'encrypted.cms'
        BACKUP.create_backup(output, FakeCompose(self.source), self.certificate)
        value = bytearray(output.read_bytes())
        value[-1] ^= 1
        output.write_bytes(value)
        sidecar = tools.manifest_path(output)
        manifest = json.loads(sidecar.read_text())
        manifest['sha256'] = tools.sha256(output)
        sidecar.write_text(json.dumps(manifest))
        with self.assertRaises(tools.BackupError):
            with tools.prepared_snapshot(output, self.key):
                pass

    def test_installation_bundle_restores_both_verified_components(self):
        proxy = self.folder/'proxy.tar.gz'
        proxy_archive(proxy, self.folder)
        compose = FakeCompose(self.source, proxy)
        output = self.folder/'installation.cms'
        BACKUP.create_backup(output, compose, self.certificate, include_proxy=True, maintenance=True)
        self.assertEqual(compose.calls[-1], ('start', 'app', 'npm'))
        with tools.prepared_snapshot(output, self.key) as (snapshot, recovered_proxy):
            self.assertEqual(tools.logical_fingerprint(snapshot), tools.logical_fingerprint(self.source))
            self.assertEqual(tools.sha256(recovered_proxy), tools.sha256(proxy))
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_key_and_payload_symlinks_are_rejected(self):
        link = self.folder/'key.pem'
        link.symlink_to(self.key)
        with self.assertRaises(tools.BackupError):
            tools.regular_file(link, private=True)
        output = self.folder/'outside.cms'
        output.symlink_to(self.source)
        with self.assertRaises(tools.BackupError):
            BACKUP.create_backup(output, FakeCompose(self.source), self.certificate)


if __name__ == '__main__':
    unittest.main()
