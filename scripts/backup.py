#!/usr/bin/env python3
"""Create verified private backups; optionally encrypt and include NPM in maintenance."""
import argparse
from datetime import datetime, timezone
import os
import secrets
import signal
import sys
from pathlib import Path
import tarfile
import tempfile

from backup_tools import (ROOT, BackupError, Compose, artifact_manifest, encrypt,
                          generate_keys, manifest_path, now, prepared_snapshot,
                          publish_file, retain, sha256, sqlite_integrity, verify_proxy_archive, write_json)


def snapshot(compose, output, stopped=False):
    # Preserve ordinary backup behavior: use the live container's actual
    # environment and a separate cache. The maintenance path needs a one-shot
    # process because its app is deliberately stopped.
    token = secrets.token_hex(8)
    cache, exported = f'/tmp/backup-cache-{token}.db', f'/tmp/backup-{token}.sqlite3'
    try:
        if not stopped:
            compose.run('exec', '-T', 'app', '/usr/local/bin/openboard',
                        '--db', cache, '--backup', exported)
        with Path(output).open('xb') as stream:
            if stopped:
                command = ('umask 077; /usr/local/bin/openboard --db /tmp/backup-cache.db '
                           '--backup /tmp/backup.sqlite3; cat /tmp/backup.sqlite3')
                compose.run('run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh',
                            'app', '-ec', command, stdout=stream)
            else:
                compose.run('exec', '-T', 'app', 'cat', exported, stdout=stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(output, 0o600)
        return sqlite_integrity(output)
    finally:
        if not stopped:
            try:
                compose.run('exec', '-T', 'app', 'rm', '-f', exported, cache,
                            cache+'-wal', cache+'-shm', timeout=20)
            except BackupError:
                pass


def installation_payload(compose, folder):
    running = set(compose.run('ps', '--status', 'running', '--services').stdout.decode().split())
    services = [name for name in ('app', 'npm') if name in running]
    if set(services) != {'app', 'npm'}:
        raise BackupError('Installation backup requires the existing app and NPM services to be running.')
    started_at = now()
    try:
        if services:
            compose.run('stop', *services)
        database = folder/'application.sqlite3'
        metadata = snapshot(compose, database, stopped=True)
        proxy = folder/'proxy.tar.gz'
        with proxy.open('xb') as stream:
            compose.run('run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar',
                        'npm', '-C', '/', '-czf', '-', 'data', 'etc/letsencrypt', stdout=stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(proxy, 0o600)
        verify_proxy_archive(proxy)
        # The actual files remain inside the encrypted installation payload.
        contents = {path.name: {'sha256': sha256(path), 'bytes': path.stat().st_size}
                    for path in (database, proxy)}
        contents['maintenance_started_at'] = started_at
        write_json(folder/'contents.json', contents)
        bundle = folder/'installation.tar'
        with tarfile.open(bundle, 'w') as archive:
            for path in (database, proxy, folder/'contents.json'):
                archive.add(path, arcname=path.name, recursive=False)
        os.chmod(bundle, 0o600)
        return bundle, metadata
    finally:
        # Restart only services that were running. Never create/reset accounts,
        # configuration, certificates or volumes during backup.
        if services:
            compose.run('start', *services)


def create_backup(output, compose, encrypt_to=None, include_proxy=False, maintenance=False):
    output = Path(output)
    if include_proxy and (not encrypt_to or not maintenance):
        raise BackupError('Including proxy configuration requires --encrypt-to and explicit --maintenance.')
    if output.exists() or output.is_symlink() or manifest_path(output).exists():
        raise BackupError('Destination already exists; no file was overwritten.')
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    published = False
    with tempfile.TemporaryDirectory(prefix='.openboard-backup-', dir=output.parent) as directory:
        folder = Path(directory)
        if include_proxy:
            payload, metadata = installation_payload(compose, folder)
        else:
            payload = folder/'application.sqlite3'
            metadata = snapshot(compose, payload)
        if encrypt_to:
            encrypted = folder/'encrypted.cms'
            encrypt(payload, encrypted, encrypt_to)
            payload = encrypted
        manifest = artifact_manifest(output, payload, 'installation' if include_proxy else 'application',
                                     metadata, encrypted=bool(encrypt_to))
        try:
            publish_file(payload, output)
            published = True
            write_json(manifest_path(output), manifest)
        except Exception:
            if published:
                output.unlink(missing_ok=True)
            raise
    return manifest


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--output', type=Path)
    result.add_argument('--compose-file', type=Path)
    result.add_argument('--env-file', type=Path)
    result.add_argument('--project-name')
    result.add_argument('--encrypt-to', type=Path, help='Public RSA recipient certificate; private key is unnecessary for backups.')
    result.add_argument('--include-proxy', action='store_true', help='Include NPM configuration and certificates in an encrypted bundle.')
    result.add_argument('--maintenance', action='store_true', help='Permit stopping/restarting the currently running app and NPM for this backup.')
    result.add_argument('--retention-keep', type=int, help='Keep this many checksum-verified backups in the output directory, at least one.')
    result.add_argument('--generate-key', type=Path, metavar='NEW_DIRECTORY', help='Create a private RSA key and public recipient certificate, then exit.')
    result.add_argument('--verify', type=Path, metavar='BACKUP', help='Verify an existing backup and its manifest without Docker.')
    result.add_argument('--decrypt-key', type=Path, help='Private key used only with --verify for encrypted backups.')
    return result


def main(argv=None):
    arguments = parser().parse_args(argv)
    def interrupted(*_):
        raise BackupError('Backup interrupted; maintenance cleanup was attempted.')
    previous_signals = {number: signal.signal(number, interrupted) for number in (signal.SIGTERM, signal.SIGINT)}
    try:
        if arguments.retention_keep is not None and arguments.retention_keep < 1:
            raise BackupError('Retention must preserve at least one verified backup.')
        if arguments.generate_key:
            if any((arguments.output, arguments.verify, arguments.include_proxy, arguments.encrypt_to)):
                raise BackupError('Key generation is a separate operation.')
            generate_keys(arguments.generate_key)
            print('Created recipient.pem and private.pem with private permissions. Keep the private key separate from backups.')
            return 0
        if arguments.verify:
            with prepared_snapshot(arguments.verify, arguments.decrypt_key):
                pass
            print('Backup checksum, decryption, SQLite integrity and manifest verified.')
            return 0
        if arguments.decrypt_key:
            raise BackupError('--decrypt-key is only used when verifying or restoring a backup.')
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        suffix = '.tar.cms' if arguments.include_proxy else '.cms' if arguments.encrypt_to else '.sqlite3'
        output = arguments.output or ROOT/'backups'/f'openboard-{stamp}{suffix}'
        compose = Compose(arguments.compose_file, arguments.env_file, arguments.project_name)
        create_backup(output, compose, arguments.encrypt_to, arguments.include_proxy, arguments.maintenance)
        if arguments.retention_keep:
            retain(output.parent, arguments.retention_keep)
        print(f'Verified backup and manifest saved in {output} (0600).')
        return 0
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print('Backup operation failed. Check paths, permissions and service health.', file=sys.stderr)
        return 1
    finally:
        for number, previous in previous_signals.items():
            signal.signal(number, previous)


if __name__ == '__main__':
    raise SystemExit(main())
