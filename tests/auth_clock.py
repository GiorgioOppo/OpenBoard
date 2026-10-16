"""Build a shared test server whose auth.c clock stays within one quota window.

HTTP deadlines and wall-clock session timestamps remain real. Password hashing
and the production quotas are unchanged. The cached TemporaryDirectory owns the
fixture executable until this test process exits.
"""
from functools import lru_cache
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


@lru_cache(maxsize=1)
def _compiled_server():
    compiler = shlex.split(os.environ.get('CC', 'cc'))
    cflags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', 'openssl'], text=True))
    libraries = shlex.split(subprocess.check_output(['pkg-config', '--libs', 'openssl'], text=True))
    flags = ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Wpedantic',
             '-D_POSIX_C_SOURCE=200809L', *cflags]
    if 'sanitize' in os.environ.get('OPENBOARD_BINARY', ''):
        flags += ['-fsanitize=address,undefined']
    directory = tempfile.TemporaryDirectory(prefix='openboard-auth-transport-')
    executable = Path(directory.name) / 'openboard-auth-clock'
    sources = [str(path) for path in sorted((ROOT / 'src').glob('*.c'))
               if path.name != 'auth.c']
    try:
        build = subprocess.run(
            [*compiler, *flags, str(ROOT / 'tests/fixtures/auth_transport_clock.c'),
             *sources, '-o', str(executable), '-lsqlite3', '-pthread', *libraries],
            capture_output=True, text=True, timeout=60)
        if build.returncode:
            raise RuntimeError('Authentication clock fixture build failed: ' + build.stderr)
    except BaseException:
        directory.cleanup()
        raise
    return directory, executable


def authentication_clock_binary():
    return _compiled_server()[1]
