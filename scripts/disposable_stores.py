"""Create only fresh, isolated Docker stores for recovery and integration tests.

No Compose configuration, deployment environment or existing volume is read.
Every Docker image must already exist locally (--pull=never).
"""
from contextlib import AbstractContextManager
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import time
import uuid

from backup_tools import ROOT, BackupError


def project_images():
    # Read only the public source file, never resolved Compose or .env.
    names = re.findall(r'^\s+image:\s+(openboard[^\s]+)\s*$', (ROOT/'compose.yaml').read_text(), re.MULTILINE)
    result = {}
    for image in names:
        repository = image.split(':', 1)[0]
        result[repository] = image
    return result


def free_port():
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        return reserve.getsockname()[1]


def docker(*arguments, environment=None, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
           timeout=180, check=True):
    try:
        result = subprocess.run(['docker', *arguments], env=environment,
                                stdin=stdin, stdout=stdout, stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        raise BackupError('Disposable Docker operation could not complete.') from None
    if check and result.returncode:
        raise BackupError('Disposable Docker operation failed; no container configuration or logs were printed.')
    return result


class DisposableStores(AbstractContextManager):
    def __init__(self, postgres_image=None, mongo_image=None, publish=False):
        images = project_images()
        self.postgres_image = postgres_image or images['openboard-postgres']
        self.mongo_image = mongo_image or images['openboard-mongo']
        self.prefix = 'openboard-recovery-' + uuid.uuid4().hex
        self.network = self.prefix + '-net'
        self.postgres = self.prefix + '-pg'
        self.mongo = self.prefix + '-mongo'
        self.containers = []
        self.network_created = False
        self.publish = publish
        self.pg_port = free_port() if publish else 5432
        self.mongo_port = free_port() if publish else 27017
        while publish and self.mongo_port == self.pg_port:
            self.mongo_port = free_port()
        self.variables = {name: secrets.token_hex(32) for name in (
            'POSTGRES_PASSWORD', 'POSTGRES_APP_PASSWORD', 'MONGO_INITDB_ROOT_PASSWORD',
            'OPENBOARD_MONGO_APP_PASSWORD')}
        self.environment = os.environ.copy()
        self.environment.update(self.variables)

    def __enter__(self):
        try:
            # A container-only recovery needs no host connectivity. Native
            # integration clients, however, use published loopback ports: do
            # not depend on forwarding behavior of Docker internal bridges.
            network = ['network', 'create']
            if not self.publish:
                network.append('--internal')
            docker(*network, '--label', 'openboard.disposable=true', self.network)
            self.network_created = True
            self._start(self.postgres, self.postgres_image, {
                'POSTGRES_USER': 'postgres', 'POSTGRES_DB': 'openboard',
                'POSTGRES_PASSWORD': self.variables['POSTGRES_PASSWORD'],
                'POSTGRES_APP_PASSWORD': self.variables['POSTGRES_APP_PASSWORD'],
                'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256'},
                'postgres-init.sh', '/docker-entrypoint-initdb.d/10-openboard.sh', self.pg_port, 5432)
            self._start(self.mongo, self.mongo_image, {
                'MONGO_INITDB_ROOT_USERNAME': 'root', 'MONGO_INITDB_DATABASE': 'openboard',
                'MONGO_INITDB_ROOT_PASSWORD': self.variables['MONGO_INITDB_ROOT_PASSWORD'],
                'OPENBOARD_MONGO_APP_PASSWORD': self.variables['OPENBOARD_MONGO_APP_PASSWORD']},
                'mongo-init.js', '/docker-entrypoint-initdb.d/10-openboard.js', self.mongo_port, 27017)
            self._wait(self.postgres, ['sh', '-ec', 'PGPASSWORD="$POSTGRES_APP_PASSWORD" psql -h 127.0.0.1 -U openboard -d openboard -Atqc "SELECT 1"'])
            self._wait(self.mongo, ['mongosh', '--host', '127.0.0.1', '--quiet', '--eval',
                       'if (!db.getSiblingDB("openboard").auth("openboard", process.env.OPENBOARD_MONGO_APP_PASSWORD)) quit(1)'])
            if self.publish:
                self._wait_host(self.postgres, self.pg_port)
                self._wait_host(self.mongo, self.mongo_port)
            return self
        except Exception:
            self.__exit__(*sys.exc_info())
            raise

    def _start(self, name, image, variables, init_source, init_destination, host_port, container_port):
        self.containers.append(name)
        command = ['run', '--pull=never', '--detach', '--network', self.network, '--name', name,
                   '--label', 'openboard.disposable=true', '--mount',
                   f'type=bind,src={ROOT / "scripts" / init_source},dst={init_destination},readonly']
        for variable in variables:
            command += ['--env', variable]
        if self.publish:
            command += ['--publish', f'127.0.0.1:{host_port}:{container_port}']
        environment = os.environ.copy()
        environment.update(variables)
        docker(*command, image, environment=environment)

    def _wait(self, container, command):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            state = docker('inspect', '--format', '{{.State.Status}}', container, timeout=5).stdout.strip()
            if state in (b'exited', b'dead', b'removing'):
                raise BackupError('Disposable database stopped before becoming ready.')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                result = docker('exec', container, *command, timeout=min(10, remaining), check=False)
                if not result.returncode:
                    return
            except BackupError:
                pass
            time.sleep(min(.15, max(0, deadline - time.monotonic())))
        raise BackupError('Disposable database readiness deadline exceeded.')

    def _wait_host(self, container, port):
        """Check the exact runner-to-container route used by native drivers."""
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            state = docker('inspect', '--format', '{{.State.Status}}', container, timeout=5).stdout.strip()
            if state in (b'exited', b'dead', b'removing'):
                raise BackupError('Disposable database stopped before its published port became ready.')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=min(1, remaining)):
                    return
            except OSError:
                time.sleep(min(.15, max(0, deadline - time.monotonic())))
        raise BackupError('Disposable database published loopback port is unavailable to the test runner.')

    def urls(self, host=False):
        if host and not self.publish:
            raise BackupError('This disposable store does not publish host ports.')
        pg_host, mongo_host = ('127.0.0.1', '127.0.0.1') if host else (self.postgres, self.mongo)
        return {
            'OPENBOARD_POSTGRES_URL': f'postgresql://openboard:{self.variables["POSTGRES_APP_PASSWORD"]}@{pg_host}:{self.pg_port if host else 5432}/openboard?connect_timeout=10',
            'OPENBOARD_MONGODB_URI': f'mongodb://openboard:{self.variables["OPENBOARD_MONGO_APP_PASSWORD"]}@{mongo_host}:{self.mongo_port if host else 27017}/openboard?authSource=openboard&serverSelectionTimeoutMS=5000&connectTimeoutMS=5000',
        }

    def migrate_snapshot(self, source, output, app_image=None):
        image = app_image or project_images()['openboard']
        name = self.prefix + '-expected'
        self.containers.append(name)
        command = ('umask 077; cat > /tmp/source.sqlite3; '
                   'env -u OPENBOARD_POSTGRES_URL -u OPENBOARD_MONGODB_URI '
                   '-u OPENBOARD_POSTGRES_URL_FILE -u OPENBOARD_MONGODB_URI_FILE '
                   '/usr/local/bin/openboard --db /tmp/source.sqlite3 --no-demo '
                   '--backup /tmp/expected.sqlite3; cat /tmp/expected.sqlite3')
        with Path(source).open('rb') as input_stream, Path(output).open('xb') as output_stream:
            docker('run', '--pull=never', '--rm', '--interactive', '--network', 'none',
                   '--name', name, '--label', 'openboard.disposable=true', '--read-only',
                   '--tmpfs', '/tmp:rw,nosuid,noexec,size=512m,uid=10001,gid=10001,mode=0700',
                   '--entrypoint', '/bin/sh', image, '-ec', command,
                   stdin=input_stream, stdout=output_stream)
            output_stream.flush()
            os.fsync(output_stream.fileno())
        os.chmod(output, 0o600)

    def restore_and_export(self, source, output, app_image=None):
        image = app_image or project_images()['openboard']
        name = self.prefix + '-import'
        self.containers.append(name)
        environment = {key: value for key, value in os.environ.items() if not key.startswith('OPENBOARD_')}
        environment.update(self.urls())
        command = ['run', '--pull=never', '--rm', '--interactive', '--network', self.network,
                   '--name', name, '--label', 'openboard.disposable=true', '--read-only',
                   '--tmpfs', '/tmp:rw,nosuid,noexec,size=512m,uid=10001,gid=10001,mode=0700',
                   '--env', 'OPENBOARD_POSTGRES_URL', '--env', 'OPENBOARD_MONGODB_URI',
                   '--entrypoint', '/bin/sh', image, '-ec',
                   'umask 077; cat > /tmp/source.sqlite3; /usr/local/bin/openboard --db /tmp/source.sqlite3 --no-demo --backup /tmp/check.sqlite3; cat /tmp/check.sqlite3']
        with Path(source).open('rb') as input_stream, Path(output).open('xb') as output_stream:
            docker(*command, environment=environment, stdin=input_stream, stdout=output_stream)
            output_stream.flush()
            os.fsync(output_stream.fileno())
        os.chmod(output, 0o600)
        # Rehydrate through a second fresh cache to prove that the output was
        # persisted into both stores, not merely copied from the import file.
        name = self.prefix + '-export'
        self.containers.append(name)
        with Path(output).open('wb') as output_stream:
            docker('run', '--pull=never', '--rm', '--network', self.network, '--name', name,
                   '--label', 'openboard.disposable=true', '--read-only', '--tmpfs',
                   '/tmp:rw,nosuid,noexec,size=512m,uid=10001,gid=10001,mode=0700',
                   '--env', 'OPENBOARD_POSTGRES_URL', '--env', 'OPENBOARD_MONGODB_URI',
                   '--entrypoint', '/bin/sh', image, '-ec',
                   'umask 077; /usr/local/bin/openboard --db /tmp/cold-cache.db --no-demo --backup /tmp/check.sqlite3; cat /tmp/check.sqlite3',
                   environment=environment, stdout=output_stream)
            output_stream.flush()
            os.fsync(output_stream.fileno())

    def __exit__(self, exception_type, *_):
        failed = False
        for name in reversed(self.containers):
            try:
                result = docker('rm', '--force', '--volumes', name, timeout=30, check=False)
                if name in (self.postgres, self.mongo) and result.returncode:
                    failed = True
            except BackupError:
                failed = True
        if self.network_created:
            try:
                result = docker('network', 'rm', self.network, timeout=30, check=False)
                failed = failed or bool(result.returncode)
            except BackupError:
                failed = True
        if failed and exception_type is None:
            raise BackupError('Disposable cleanup could not be confirmed; inspect test resources privately.')
        return False
