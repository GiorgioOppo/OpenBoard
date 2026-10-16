"""Compile the real private authentication limiter into a disposable harness."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]


class AuthenticationLimiterTests(unittest.TestCase):
    def test_bounded_limiter_collision_expiry_isolation_and_concurrent_reservations(self):
        compiler=shlex.split(os.environ.get('CC','cc'))
        cflags=shlex.split(subprocess.check_output(['pkg-config','--cflags','openssl'],text=True))
        libraries=shlex.split(subprocess.check_output(['pkg-config','--libs','openssl'],text=True))
        flags=['-std=c11','-O1','-g','-Wall','-Wextra','-Wpedantic','-D_POSIX_C_SOURCE=200809L',*cflags]
        if 'sanitize' in os.environ.get('OPENBOARD_BINARY',''):
            flags+=['-fsanitize=address,undefined']
        with tempfile.TemporaryDirectory(prefix='openboard-rate-unit-') as directory:
            directory=Path(directory)
            http=directory/'http.o'
            build=subprocess.run([*compiler,*flags,'-Dmain=openboard_http_entry','-c',str(ROOT/'src/http.c'),'-o',str(http)],capture_output=True,text=True,timeout=60)
            self.assertEqual(build.returncode,0,build.stderr)
            sources=[str(p) for p in sorted((ROOT/'src').glob('*.c')) if p.name not in ('auth.c','http.c')]
            executable=directory/'rate-limits'
            build=subprocess.run([*compiler,*flags,str(ROOT/'tests/fixtures/auth_rate_limits.c'),*sources,str(http),'-o',str(executable),'-lsqlite3','-pthread',*libraries],capture_output=True,text=True,timeout=60)
            self.assertEqual(build.returncode,0,build.stderr)
            result=subprocess.run([str(executable)],capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('atomic reservations OK',result.stdout)


if __name__=='__main__':
    unittest.main()
