#!/usr/bin/env python3
"""Run private backups at a bounded interval; explicitly opt into this worker."""
import argparse
import fcntl
from datetime import datetime, timezone
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import threading
import time

from backup_tools import ROOT, BackupError, now, retain, write_json


def run_process(command, timeout):
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # SIGTERM lets backup.py execute its maintenance finally block. Killing
        # the entire process group first also interrupts a blocked Docker client.
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=180)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise BackupError('Scheduled backup timeout; verify service state privately.') from None
    return process


def run_backup(arguments):
    command = [sys.executable, str(ROOT/'scripts/backup.py')]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    suffix = '.tar.cms' if arguments.include_proxy else '.cms'
    command += ['--output', str(arguments.directory/f'openboard-{stamp}{suffix}'),
                '--encrypt-to', str(arguments.encrypt_to)]
    for name in ('compose_file', 'env_file', 'project_name'):
        value = getattr(arguments, name)
        if value is not None:
            command += ['--' + name.replace('_', '-'), str(value)]
    if arguments.include_proxy:
        command += ['--include-proxy', '--maintenance']
    started = now()
    status = {'format': 'openboard-backup-status-v1', 'started_at': started,
              'status': 'running', 'last_success_at': None}
    state_path = arguments.directory/'backup-status.json'
    if state_path.exists() and not state_path.is_symlink():
        try:
            import json
            if state_path.stat().st_size < 65536:
                previous = json.loads(state_path.read_text())
                candidate = previous.get('last_success_at')
                if candidate is not None:
                    datetime.fromisoformat(candidate)
                    status['last_success_at'] = candidate
        except (OSError, ValueError, AttributeError):
            pass
    write_json(state_path, status, replace=True)
    try:
        result = run_process(command, arguments.timeout)
        if result.returncode:
            raise BackupError('Scheduled backup failed.')
        removed = retain(arguments.directory, arguments.keep)
        status.update(status='ok', finished_at=now(), last_success_at=now(), retained_pruned=removed)
    except (BackupError, OSError, subprocess.SubprocessError):
        status.update(status='failed', finished_at=now(), error='backup_or_retention_failed')
    write_json(state_path, status, replace=True)
    return status['status'] == 'ok'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--encrypt-to', type=Path, required=True)
    parser.add_argument('--interval-hours', type=float, default=24)
    parser.add_argument('--keep', type=int, default=7)
    parser.add_argument('--timeout', type=int, default=900)
    parser.add_argument('--once', action='store_true', help='Perform one scheduled cycle and exit (for an external timer).')
    parser.add_argument('--include-proxy', action='store_true', help='Explicitly permit maintenance for each scheduled installation backup.')
    parser.add_argument('--compose-file', type=Path)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--project-name')
    arguments = parser.parse_args(argv)
    if not .05 <= arguments.interval_hours <= 8760 or arguments.keep < 1 or not 30 <= arguments.timeout <= 86400:
        parser.error('Use an interval of 0.05–8760 hours, keep at least one backup, and timeout 30–86400 seconds.')
    arguments.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = arguments.directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        parser.error('Backup directory must be owned by this user, not a symlink, and private (0700).')
    lock = os.open(arguments.directory/'.scheduler.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    stopped = threading.Event()
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('A backup scheduler already owns this directory.')
        signal.signal(signal.SIGTERM, lambda *_: stopped.set())
        signal.signal(signal.SIGINT, lambda *_: stopped.set())
        while not stopped.is_set():
            beginning = time.monotonic()
            success = run_backup(arguments)
            if arguments.once:
                return 0 if success else 1
            print('Backup cycle completed.' if success else 'Backup cycle failed; see private backup-status.json.', flush=True)
            stopped.wait(max(0, arguments.interval_hours * 3600 - (time.monotonic() - beginning)))
    finally:
        os.close(lock)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
