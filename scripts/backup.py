#!/usr/bin/env python3
"""Export a coherent, complete SQLite recovery snapshot from the Compose stack."""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def compose(*arguments, timeout=180):
    result = subprocess.run(["docker", "compose", *arguments], cwd=ROOT, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Operazione Docker non riuscita. Verifica lo stato dei servizi; nessun contenuto del backup mostrato.")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    parser.add_argument("--output", type=Path, default=ROOT / "backups" / f"openboard-{stamp}.sqlite3")
    args = parser.parse_args()
    token = secrets.token_hex(8)
    cache = f"/tmp/openboard-backup-cache-{token}.db"
    snapshot = f"/tmp/openboard-backup-{token}.sqlite3"
    reserved = False
    copied = False
    prepared = False
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
        reserved = True
        prepared = True
        compose("exec", "-T", "app", "/usr/local/bin/openboard", "--db", cache, "--backup", snapshot)
        # Docker's archive API may not see tmpfs mounts in a read-only container.
        # Stream only to the private file, never to terminal output or memory.
        with args.output.open("wb") as output:
            result = subprocess.run(["docker", "compose", "exec", "-T", "app", "cat", snapshot],
                                    cwd=ROOT, stdout=output, stderr=subprocess.PIPE, timeout=180)
            if result.returncode or output.tell() == 0:
                raise RuntimeError("Trasferimento del backup non riuscito; nessun contenuto mostrato.")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(args.output, 0o600)
        copied = True
        print(f"Backup completo salvato in {args.output} (0600).")
        return 0
    except FileExistsError:
        print("Destinazione già presente: nessun file sovrascritto.", file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        if reserved and not copied:
            args.output.unlink(missing_ok=True)
        if prepared:
            try:
                compose("exec", "-T", "app", "rm", "-f", snapshot, cache, cache + "-wal", cache + "-shm", timeout=20)
            except (OSError, subprocess.SubprocessError, RuntimeError):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
