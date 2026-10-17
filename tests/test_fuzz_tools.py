"""Fuzzer failure diagnostics, deadline and synthetic-data isolation contracts."""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('openboard_fuzz_tools', ROOT / 'scripts/fuzz.py')
FUZZ = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FUZZ)


class FuzzTools(unittest.TestCase):
    def test_child_configuration_drops_deployment_and_enforces_sanitizers(self):
        with patch.dict(os.environ, {'OPENBOARD_POSTGRES_URL': 'synthetic-private-uri',
                                     'OPENBOARD_MONGODB_URI_FILE': 'synthetic-private-file',
                                     'ASAN_OPTIONS': 'abort_on_error=0',
                                     'UBSAN_OPTIONS': 'halt_on_error=0'}):
            env = FUZZ.environment()
        self.assertFalse(any(key.startswith('OPENBOARD_') for key in env))
        self.assertIn('abort_on_error=1', env['ASAN_OPTIONS'])
        self.assertIn('halt_on_error=1', env['UBSAN_OPTIONS'])
        self.assertNotIn('synthetic-private', str(env))

    def test_compiler_and_metadata_have_deadlines_and_keep_partial_diagnostics(self):
        with tempfile.TemporaryDirectory(prefix='openboard-fuzz-failure-') as folder:
            output = Path(folder)
            failure = subprocess.TimeoutExpired(['synthetic-clang'], 180,
                                                output=b'PARTIAL_BUILD\n', stderr=b'DIAGNOSTIC\n')
            with patch.object(FUZZ.subprocess, 'check_output', side_effect=['', '', 'Synthetic Clang\n']) as metadata, \
                 patch.object(FUZZ.subprocess, 'run', side_effect=failure) as compiler:
                with self.assertRaisesRegex(RuntimeError, 'compilation timed out'):
                    FUZZ.build(['synthetic-clang'], output, ['http'], {})
            self.assertTrue(all(call.kwargs['timeout'] == 15 for call in metadata.call_args_list))
            self.assertEqual(compiler.call_args.kwargs['timeout'], 180)
            log = output / 'build.log'
            self.assertIn('PARTIAL_BUILD', log.read_text())
            self.assertIn('DIAGNOSTIC', log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_campaign_timeout_fails_and_preserves_source_corpus(self):
        before = (ROOT / 'fuzz/corpus.json').read_bytes()
        args = argparse.Namespace(replay=None, seconds=1, runs=100, seed=20261017)
        with tempfile.TemporaryDirectory(prefix='openboard-fuzz-campaign-') as folder:
            output = Path(folder)
            failure = subprocess.TimeoutExpired(['synthetic-target'], 31,
                                                output=b'PARTIAL_TARGET\n', stderr=b'SYNTHETIC_TRACE\n')
            with patch.object(FUZZ.subprocess, 'run', side_effect=failure) as execute:
                result = FUZZ.campaign(output, 'http', args, {})
            self.assertEqual(result['exit_code'], 124)
            self.assertEqual(execute.call_args.kwargs['timeout'], 31)
            self.assertIn('PARTIAL_TARGET', (output / 'http.log').read_text())
            self.assertIn('SYNTHETIC_TRACE', (output / 'http.log').read_text())
            self.assertTrue((output / 'corpus/http/seed-get').is_file())
            self.assertTrue((output / 'artifacts/http').is_dir())
        self.assertEqual((ROOT / 'fuzz/corpus.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
