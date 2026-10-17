#!/usr/bin/env python3
"""Verify full application recovery into new isolated Docker databases, then remove them."""
import argparse
from pathlib import Path
import tempfile

from backup_tools import (BackupError, logical_fingerprint, prepared_snapshot,
                          verify_proxy_archive)
from disposable_stores import DisposableStores, docker, project_images


def restore_proxy_archive(archive, image):
    import uuid
    name = 'openboard-recovery-proxy-' + uuid.uuid4().hex
    command = ('tar -xzf - -C /; /opt/certbot/bin/python -c '
               "'import sqlite3; c=sqlite3.connect(\"file:/data/database.sqlite?mode=ro\",uri=True); "
               "assert c.execute(\"PRAGMA integrity_check\").fetchall()==[(\"ok\",)]; c.close()'")
    try:
        with Path(archive).open('rb') as source:
            docker('run', '--pull=never', '--rm', '--interactive', '--network', 'none', '--name', name,
                   '--label', 'openboard.disposable=true', '--tmpfs', '/data:rw,nosuid,noexec,size=256m',
                   '--tmpfs', '/etc/letsencrypt:rw,nosuid,noexec,size=64m', '--entrypoint', '/bin/sh',
                   image, '-ec', command, stdin=source)
    finally:
        docker('rm', '--force', '--volumes', name, check=False)


def check_recovery(backup, decrypt_key=None, postgres_image=None, mongo_image=None, app_image=None, proxy_image=None):
    with prepared_snapshot(backup, decrypt_key) as (source, proxy):
        if proxy:
            verify_proxy_archive(proxy)
        with tempfile.TemporaryDirectory(prefix='openboard-recovery-result-') as folder:
            output = Path(folder)/'restored.sqlite3'
            migrated = Path(folder)/'expected.sqlite3'
            with DisposableStores(postgres_image, mongo_image) as stores:
                # An old backup is compared with the current binary's migrated
                # copy, not its old schema. Import that same copy so defaults
                # generated during migration are evaluated only once.
                stores.migrate_snapshot(source, migrated, app_image)
                expected = logical_fingerprint(migrated)
                stores.restore_and_export(migrated, output, app_image)
                if logical_fingerprint(output) != expected:
                    raise BackupError('Recovered application rows differ from the verified backup.')
            if proxy:
                restore_proxy_archive(proxy, proxy_image or project_images()['openboard-proxy'])
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    parser.add_argument('--decrypt-key', type=Path)
    for name in ('postgres', 'mongo', 'app', 'proxy'):
        parser.add_argument('--' + name + '-image')
    arguments = parser.parse_args(argv)
    try:
        check_recovery(arguments.backup, arguments.decrypt_key, arguments.postgres_image,
                       arguments.mongo_image, arguments.app_image, arguments.proxy_image)
        print('Complete recovery verified in isolated disposable containers; application rows match and all test resources were removed.')
        return 0
    except (BackupError, OSError, ValueError):
        print('Recovery verification failed. No existing deployment, volume or environment file was used.', file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
