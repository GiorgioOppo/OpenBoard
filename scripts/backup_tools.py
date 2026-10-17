"""Private backup primitives: integrity, standard CMS encryption and manifests.

Encryption uses OpenSSL CMS AuthEnvelopedData with AES-256-GCM and RSA-OAEP.
No cryptographic algorithm or proprietary encryption envelope is implemented.
https://docs.openssl.org/3.0/man1/openssl-cms/
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
import posixpath
import tarfile
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FORMAT = 'openboard-backup-v1'
ENCRYPTION = 'openssl-cms-aes-256-gcm-rsa-oaep'


class BackupError(RuntimeError):
    """A deliberately sanitized operational error."""


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def regular_file(path, private=False):
    path = Path(path)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or not info.st_size:
                raise BackupError('A nonempty regular file is required.')
            if private and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
                raise BackupError('Private key must belong to this user with permissions 0600 or stricter.')
    except OSError:
        raise BackupError('Required file is unavailable or is a symbolic link.') from None
    return path


def sha256(path):
    regular_file(path)
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def fsync_directory(folder):
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_file(source, destination):
    """Publish a private complete file without replacing an existing path."""
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(source, 0o600)
    with source.open('rb') as stream:
        os.fsync(stream.fileno())
    try:
        os.link(source, destination)
    except FileExistsError:
        raise BackupError('Destination already exists; no file was overwritten.') from None
    fsync_directory(destination.parent)


def write_json(path, data, replace=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.openboard-json-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
            fsync_directory(path.parent)
        else:
            publish_file(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sqlite_integrity(path):
    regular_file(path)
    try:
        connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
        try:
            if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise BackupError('SQLite integrity verification failed.')
            if connection.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise BackupError('SQLite foreign-key verification failed.')
            schema = connection.execute('PRAGMA user_version').fetchone()[0]
            if schema < 1:
                raise BackupError('Snapshot has no supported application schema version.')
            tables = connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
            counts = {}
            for (table,) in tables:
                name = '"' + table.replace('"', '""') + '"'
                counts[table] = connection.execute('SELECT count(*) FROM ' + name).fetchone()[0]
            if not {'boards', 'cards', 'users'}.issubset(counts):
                raise BackupError('Snapshot is missing core application tables.')
            return {'schema_version': schema, 'table_rows': counts, 'integrity': 'ok'}
        finally:
            connection.close()
    except sqlite3.Error:
        raise BackupError('Snapshot is not a valid, complete SQLite database.') from None


def logical_fingerprint(path):
    """Compare all application rows without exposing their contents."""
    sqlite_integrity(path)
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        result = {}
        for (table,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            name = '"' + table.replace('"', '""') + '"'
            columns = [row[1] for row in connection.execute('PRAGMA table_info(' + name + ')')]
            rows = []
            for record in connection.execute('SELECT * FROM ' + name):
                normalized = []
                for value in record:
                    if isinstance(value, bytes):
                        value = {'blob_sha256': hashlib.sha256(value).hexdigest(), 'size': len(value)}
                    elif isinstance(value, str) and value[:1] in ('{', '['):
                        try:
                            value = {'json': json.loads(value)}
                        except (ValueError, RecursionError):
                            pass
                    normalized.append(value)
                rows.append(json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
            rows.sort()
            result[table] = {'columns': columns, 'rows': len(rows),
                             'sha256': hashlib.sha256('\n'.join(rows).encode()).hexdigest()}
        return result
    finally:
        connection.close()


def openssl(*arguments):
    binary = os.environ.get('OPENBOARD_OPENSSL', 'openssl')
    try:
        result = subprocess.run([binary, *map(str, arguments)], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    except (OSError, subprocess.SubprocessError):
        raise BackupError('OpenSSL operation failed; no key or payload was printed.') from None
    if result.returncode:
        raise BackupError('OpenSSL operation failed; check the certificate/key and OpenSSL AES-GCM support.')
    return result.stdout


def generate_keys(directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(directory, 0o700)
    try:
        with tempfile.TemporaryDirectory(prefix='.keygen-', dir=directory) as folder:
            key, certificate = Path(folder)/'private.pem', Path(folder)/'recipient.pem'
            openssl('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256',
                    '-days', '3650', '-subj', '/CN=OpenBoard backup recipient',
                    '-keyout', key, '-out', certificate)
            publish_file(key, directory/'private.pem')
            publish_file(certificate, directory/'recipient.pem')
    except Exception:
        # Never remove a published key: the caller may already have stored data.
        raise
    return directory/'recipient.pem', directory/'private.pem'


def encrypt(source, destination, certificate):
    regular_file(certificate)
    openssl('cms', '-encrypt', '-binary', '-stream', '-aes-256-gcm', '-outform', 'DER',
            '-in', source, '-out', destination, '-recip', certificate,
            '-keyopt', 'rsa_padding_mode:oaep', '-keyopt', 'rsa_oaep_md:sha256')
    os.chmod(destination, 0o600)


def decrypt(source, destination, key):
    regular_file(key, private=True)
    try:
        openssl('cms', '-decrypt', '-binary', '-inform', 'DER', '-in', source,
                '-out', destination, '-inkey', key)
        os.chmod(destination, 0o600)
    except BackupError:
        Path(destination).unlink(missing_ok=True)
        raise


def manifest_path(artifact):
    return Path(str(artifact) + '.manifest.json')


def artifact_manifest(artifact, payload, kind, metadata, encrypted=False):
    return {'format': FORMAT, 'created_at': now(), 'kind': kind,
            'artifact': Path(artifact).name, 'sha256': sha256(payload),
            'bytes': Path(payload).stat().st_size,
            'encryption': ENCRYPTION if encrypted else None,
            'snapshot': metadata}


def verify_manifest(artifact):
    artifact = regular_file(artifact)
    sidecar = regular_file(manifest_path(artifact))
    if sidecar.stat().st_size > 1024 * 1024:
        raise BackupError('Backup manifest is too large.')
    try:
        data = json.loads(sidecar.read_text())
        if (data['format'] != FORMAT or data['artifact'] != artifact.name or
                data['kind'] not in ('application', 'installation') or
                data['encryption'] not in (None, ENCRYPTION) or
                data['bytes'] != artifact.stat().st_size or data['sha256'] != sha256(artifact)):
            raise ValueError
        datetime.fromisoformat(data['created_at'])
        return data
    except (ValueError, KeyError, TypeError):
        raise BackupError('Backup manifest or artifact checksum verification failed.') from None


def retain(directory, keep):
    if keep < 1:
        raise BackupError('Retention must preserve at least one verified backup.')
    directory = Path(directory)
    verified = []
    for path in directory.glob('*.manifest.json'):
        artifact = Path(str(path)[:-len('.manifest.json')])
        try:
            metadata = verify_manifest(artifact)
            verified.append((metadata['created_at'], artifact))
        except (BackupError, OSError):
            continue  # Unknown, corrupt or incomplete files are never deleted.
    verified.sort(key=lambda entry: entry[0], reverse=True)
    for _, artifact in verified[keep:]:
        artifact.unlink()
        manifest_path(artifact).unlink()
    if len(verified) > keep:
        fsync_directory(directory)
    return max(0, len(verified) - keep)


class Compose:
    def __init__(self, compose_file=None, env_file=None, project=None):
        self.command = ['docker', 'compose', '--project-directory', str(ROOT),
                        '-f', str(compose_file or ROOT/'compose.yaml')]
        if env_file:
            self.command += ['--env-file', str(env_file)]
        if project:
            self.command += ['--project-name', project]

    def run(self, *arguments, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=180):
        try:
            result = subprocess.run([*self.command, *arguments], cwd=ROOT, stdin=stdin,
                                    stdout=stdout, stderr=subprocess.PIPE, timeout=timeout)
        except (OSError, subprocess.SubprocessError):
            raise BackupError('Docker operation could not complete; no private output was printed.') from None
        if result.returncode:
            raise BackupError('Docker operation failed; inspect service health privately.')
        return result


def verify_proxy_archive(archive):
    """Reject traversal/devices and check the stopped NPM SQLite DB plus WAL."""
    import shutil
    import sqlite3
    with tempfile.TemporaryDirectory(prefix='openboard-proxy-verify-') as directory:
        directory = Path(directory)
        try:
            with tarfile.open(archive, 'r:*') as bundle:
                names = set()
                for member in bundle:
                    name = posixpath.normpath(member.name)
                    if member.name.startswith('/') or not (name == 'data' or name.startswith('data/') or name == 'etc/letsencrypt' or name.startswith('etc/letsencrypt/')):
                        raise BackupError('Unsafe proxy archive path.')
                    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                        raise BackupError('Unsupported proxy archive member.')
                    if member.issym() or member.islnk():
                        link = member.linkname if member.islnk() or member.linkname.startswith('/') else posixpath.join(posixpath.dirname(name), member.linkname)
                        link = posixpath.normpath(link).lstrip('/')
                        if not (link == 'data' or link.startswith('data/') or link == 'etc/letsencrypt' or link.startswith('etc/letsencrypt/')):
                            raise BackupError('Unsafe proxy archive link.')
                    if name in names:
                        raise BackupError('Duplicate proxy archive path.')
                    names.add(name)
                    if name in ('data/database.sqlite', 'data/database.sqlite-wal', 'data/database.sqlite-shm'):
                        if not member.isfile():
                            raise BackupError('Proxy database payload must be regular.')
                        with bundle.extractfile(member) as source, (directory/Path(name).name).open('xb') as output:
                            shutil.copyfileobj(source, output, 1024 * 1024)
                if 'data/database.sqlite' not in names:
                    raise BackupError('Proxy archive lacks the default SQLite database.')
            connection = sqlite3.connect((directory/'database.sqlite').as_uri() + '?mode=ro', uri=True)
            try:
                if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise BackupError('Proxy SQLite integrity check failed.')
            finally:
                connection.close()
        except (tarfile.TarError, sqlite3.Error, OSError):
            raise BackupError('Proxy archive integrity check failed.') from None

@contextmanager
def prepared_snapshot(artifact, decrypt_key=None):
    """Yield verified plaintext only inside a private, automatically removed dir."""
    import tarfile
    data = verify_manifest(artifact)
    with tempfile.TemporaryDirectory(prefix='openboard-recovery-') as folder:
        folder = Path(folder)
        payload = Path(artifact)
        if data['encryption']:
            if decrypt_key is None:
                raise BackupError('An explicit private decryption key is required.')
            payload = folder/'payload'
            decrypt(artifact, payload, decrypt_key)
        proxy = None
        snapshot = payload
        if data['kind'] == 'installation':
            snapshot, proxy = folder/'application.sqlite3', folder/'proxy.tar.gz'
            try:
                with tarfile.open(payload, 'r:*') as bundle:
                    if sorted(bundle.getnames()) != ['application.sqlite3', 'contents.json', 'proxy.tar.gz']:
                        raise BackupError('Unexpected installation archive members.')
                    for name, destination in [('application.sqlite3', snapshot), ('proxy.tar.gz', proxy)]:
                        member = bundle.getmember(name)
                        if not member.isfile():
                            raise BackupError('Installation archive must contain regular payloads.')
                        with bundle.extractfile(member) as source, destination.open('xb') as output:
                            shutil.copyfileobj(source, output, 1024 * 1024)
                        os.chmod(destination, 0o600)
                    member = bundle.getmember('contents.json')
                    if not member.isfile() or member.size > 1024 * 1024:
                        raise BackupError('Invalid installation contents manifest.')
                    contents = json.load(bundle.extractfile(member))
                    for path in (snapshot, proxy):
                        if (contents[path.name]['sha256'] != sha256(path) or
                                contents[path.name]['bytes'] != path.stat().st_size):
                            raise BackupError('Installation component checksum verification failed.')
            except (tarfile.TarError, ValueError, KeyError, TypeError):
                raise BackupError('Invalid installation archive.') from None
        if proxy:
            verify_proxy_archive(proxy)
        metadata = sqlite_integrity(snapshot)
        if metadata != data['snapshot']:
            raise BackupError('Snapshot does not match its manifest.')
        yield snapshot, proxy
