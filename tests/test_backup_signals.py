"""Real POSIX signals must unwind maintenance and restore prior service state."""
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKER = r'''
import signal, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import backup
marker = Path(sys.argv[2])
class FakeCompose:
    def __init__(self, *_): pass
    def run(self, *args, **kwargs):
        if args[0] == 'ps':
            return SimpleNamespace(stdout=b'app\nnpm\n')
        if args[0] == 'stop':
            marker.write_text('stopped')
            return SimpleNamespace(stdout=b'')
        if args[0] == 'start':
            marker.write_text('started')
            return SimpleNamespace(stdout=b'')
        signal.pause()
backup.Compose = FakeCompose
raise SystemExit(backup.main(['--output', sys.argv[2]+'.cms', '--encrypt-to',
                            sys.argv[2]+'.public.pem', '--include-proxy', '--maintenance']))
'''


class BackupSignalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openboard-backup-signal-')
        self.addCleanup(self.temp.cleanup)
        self.marker = Path(self.temp.name) / 'state'

    def command(self):
        return [sys.executable, '-c', WORKER, str(ROOT / 'scripts'), str(self.marker)]

    def test_sigterm_and_sigint_restart_services_after_maintenance_interrupt(self):
        for number in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=number):
                self.marker.unlink(missing_ok=True)
                process = subprocess.Popen(self.command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 5
                    while not self.marker.exists() and time.monotonic() < deadline:
                        if process.poll() is not None:
                            self.fail('Fake maintenance worker exited before stopping services')
                        time.sleep(.01)
                    self.assertEqual(self.marker.read_text(), 'stopped')
                    process.send_signal(number)
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 1, stderr)
                    self.assertEqual(self.marker.read_text(), 'started')
                    self.assertIn(b'cleanup was attempted', stderr)
                    self.assertFalse(stdout)
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=5)

    def test_scheduler_timeout_allows_real_maintenance_finally(self):
        scripts = str(ROOT / 'scripts')
        sys.path.insert(0, scripts)
        try:
            module = runpy.run_path(str(ROOT / 'scripts/backup-schedule.py'))
        finally:
            sys.path.remove(scripts)
        with self.assertRaises(module['BackupError']):
            module['run_process'](self.command(), timeout=3)
        self.assertEqual(self.marker.read_text(), 'started')


if __name__ == '__main__':
    unittest.main()
