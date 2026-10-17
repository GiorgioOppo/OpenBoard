"""Opt-in full recovery proof uses synthetic data and newly created stores only."""
import base64
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import backup_tools as tools


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BACKUP = load('backup_recovery_operations', 'backup.py')
RECOVERY = load('backup_recovery_check', 'restore-check.py')


@unittest.skipUnless(os.environ.get('OPENBOARD_RECOVERY_TEST') == '1',
                     'Set OPENBOARD_RECOVERY_TEST=1 for isolated real-container recovery')
class CompleteRecovery(unittest.TestCase):
    def test_encrypted_application_and_npm_restore_match_every_application_table(self):
        with tempfile.TemporaryDirectory(prefix='openboard-full-recovery-test-') as folder:
            folder = Path(folder)
            source = folder/'source.sqlite3'
            with sqlite3.connect(source) as connection:
                connection.executescript((ROOT/'tests/fixtures/openboard_v6.sql').read_text())
                connection.execute("INSERT INTO users(name,username,password_hash,salt,role) VALUES(?,?,?,?,?)",
                                   ('Synthetic recovery user', 'recovery.synthetic', '0'*64, '1'*32, 'admin'))
                user = connection.execute("SELECT id FROM users WHERE username='recovery.synthetic'").fetchone()[0]
                connection.execute("INSERT INTO board_members(board_id,user_id,role) VALUES(1,?,'admin')", (user,))
                connection.execute("INSERT INTO attachments(card_id,author_id,name,mime,data_base64,size) VALUES(1,?,'synthetic.txt','text/plain',?,4)",
                                   (user, base64.b64encode(b'fake').decode()))
                connection.execute("INSERT INTO reviews(card_id,requester_id,title,description,policy) VALUES(1,?,'Recovery review','Synthetic only','all')", (user,))
            snapshot = folder/'current.sqlite3'
            environment = {name: value for name, value in os.environ.items() if not name.startswith('OPENBOARD_')}
            binary = Path(os.environ.get('OPENBOARD_BINARY', ROOT/'build/openboard'))
            result = subprocess.run([str(binary), '--db', str(source), '--no-demo', '--backup', str(snapshot)],
                                    env=environment, capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, 'Synthetic snapshot preparation failed; no process output printed.')
            metadata = tools.sqlite_integrity(snapshot)
            self.assertEqual(metadata['table_rows']['users'], 3)
            self.assertEqual(metadata['table_rows']['attachments'], 1)
            # Test restoration of NPM data without starting NPM, requesting any
            # certificates or restoring an existing volume.
            proxy_db = folder/'database.sqlite'
            with sqlite3.connect(proxy_db) as connection:
                connection.execute('CREATE TABLE synthetic_config(id INTEGER PRIMARY KEY, enabled INTEGER)')
                connection.execute('INSERT INTO synthetic_config VALUES(1,1)')
            proxy = folder/'proxy.tar.gz'
            with tarfile.open(proxy, 'w:gz') as archive:
                archive.add(proxy_db, arcname='data/database.sqlite')
            contents = {path.name: {'sha256': tools.sha256(path), 'bytes': path.stat().st_size}
                        for path in (snapshot, proxy)}
            # Installation format uses a stable component name.
            contents['application.sqlite3'] = contents.pop('current.sqlite3')
            tools.write_json(folder/'contents.json', contents)
            bundle = folder/'installation.tar'
            with tarfile.open(bundle, 'w') as archive:
                archive.add(snapshot, arcname='application.sqlite3')
                archive.add(proxy, arcname='proxy.tar.gz')
                archive.add(folder/'contents.json', arcname='contents.json')
            certificate, key = tools.generate_keys(folder/'keys')
            encrypted = folder/'payload.cms'
            tools.encrypt(bundle, encrypted, certificate)
            backup = folder/'backup.cms'
            tools.publish_file(encrypted, backup)
            tools.write_json(tools.manifest_path(backup),
                             tools.artifact_manifest(backup, backup, 'installation', metadata, encrypted=True))
            self.assertTrue(RECOVERY.check_recovery(backup, key))


if __name__ == '__main__':
    unittest.main()
