#!/usr/bin/env python3
"""Run every external-storage test on fresh disposable stores; never read .env."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

from backup_tools import ROOT, BackupError
from disposable_stores import DisposableStores


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT/'build/openboard')
    parser.add_argument('--postgres-image')
    parser.add_argument('--mongo-image')
    arguments = parser.parse_args(argv)
    try:
        with DisposableStores(arguments.postgres_image, arguments.mongo_image, publish=True) as stores:
            environment = {key: value for key, value in os.environ.items() if not key.startswith('OPENBOARD_')}
            environment.update(stores.urls(host=True), OPENBOARD_CLOUD_TEST='1', OPENBOARD_CLOUD_MIGRATION_TEST='1',
                               OPENBOARD_CLOUD_MONGO_CONTAINER=stores.mongo,
                               OPENBOARD_BINARY=str(arguments.binary.resolve()))
            result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests',
                                     '-p', 'test_cloud.py', '-v'], cwd=ROOT, env=environment,
                                    capture_output=True, text=True, timeout=900)
            output = result.stdout + result.stderr
            for password in stores.variables.values():
                output = output.replace(password, '[redacted]')
            print(output, end='')
            # Missing opt-ins/driver prerequisites must not silently turn this
            # explicit integration job into a green run with skipped tests.
            if 'skipped=' in output or 'skipped ' in output:
                raise BackupError('Full cloud integration must not skip tests.')
            return 0 if result.returncode == 0 else 1
    except (BackupError, OSError, subprocess.SubprocessError):
        print('Disposable cloud integration failed; no deployment credentials were read.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
