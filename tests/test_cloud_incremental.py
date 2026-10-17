"""Offline storage regressions with real SQLite/BSON and injected SQL failures."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class IncrementalCloudStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mongo = next((name for name in ('libmongoc-1.0', 'mongoc2')
                      if subprocess.run(['pkg-config', '--exists', name], check=False).returncode == 0), None)
        if mongo is None or subprocess.run(['pkg-config', '--exists', 'libpq'], check=False).returncode:
            raise unittest.SkipTest('Native PostgreSQL/MongoDB development drivers are required')
        packages = ['libpq', mongo, 'openssl']
        flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', *packages], text=True))
        libraries = shlex.split(subprocess.check_output(['pkg-config', '--libs', *packages], text=True))
        flags += ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Wpedantic',
                  '-D_POSIX_C_SOURCE=200809L', '-DOB_EXTERNAL_STORAGE']
        if 'sanitize' in os.environ.get('OPENBOARD_BINARY', ''):
            flags += ['-fsanitize=address,undefined']
        cls.directory = tempfile.TemporaryDirectory(prefix='openboard-cloud-unit-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.executable = Path(cls.directory.name) / 'cloud-incremental'
        compiler = shlex.split(os.environ.get('CC', 'cc'))
        result = subprocess.run([*compiler, *flags, str(ROOT / 'tests/fixtures/cloud_incremental.c'), str(ROOT / 'src/telemetry.c'),
                                 '-o', str(cls.executable), '-lsqlite3', '-pthread', *libraries],
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    def run_case(self, case, expected):
        result = subprocess.run([str(self.executable), case], capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(expected, result.stdout)

    def test_tracker_rollbacks_keys_cascades_and_connection_isolation(self):
        self.run_case('tracker', 'connection isolation OK')

    def test_only_changed_rows_publish_and_failures_do_not_commit(self):
        self.run_case('publication', 'Mongo outage OK')

    def test_documents_reject_modified_kind_raw_and_typed_value(self):
        self.run_case('integrity', 'typed projection integrity OK')


if __name__ == '__main__':
    unittest.main()
