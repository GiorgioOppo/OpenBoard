# Unreleased operations tools

These commands extend the development branch. They are not part of the immutable published `v0.6.1` source snapshot. Review the [implementation ledger](IMPROVEMENTS_NEXT_100.md) for verification status. Local encryption/integrity tests have run; container-based capture and recovery require separate execution on Docker.

## Verified encrypted backups

Requirements: Python 3, Docker Compose for capture, and OpenSSL with CMS AES-256-GCM support. Encryption uses standard CMS AuthEnvelopedData with AES-256-GCM and RSA-OAEP/SHA-256. Unsupported crypto operations fail; no plaintext fallback is produced.

Choose an access-controlled key directory outside the checkout. For example, substitute a writable secure path for `/secure/openboard-keys`:

```sh
python3 scripts/backup.py --generate-key /secure/openboard-keys
python3 scripts/backup.py --output backups/example.cms --encrypt-to /secure/openboard-keys/recipient.pem
python3 scripts/backup.py --verify backups/example.cms --decrypt-key /secure/openboard-keys/private.pem
```

Key generation refuses an existing directory. `private.pem` is private and needed only for recovery; keep a protected copy separate from backup storage. The public `recipient.pem` can be available to the backup worker. Losing the private key prevents recovery. The private key must be a regular file owned by the operator with 0600 or stricter permissions.

Capture checks SQLite integrity and foreign keys before publication. Output files and JSON manifests have private permissions and are published without overwriting existing paths. A manifest records the ciphertext checksum, size, creation time, schema and per-table row counts; treat it as private operational metadata. Keep artifact and manifest together. `--verify` checks the manifest and decrypted payload without Docker.

Checksums detect corruption. CMS encryption provides confidentiality and ciphertext integrity; these artifacts are not signed proof of their author. Store backup and manifest in a trusted directory. Default capture uses the running app; a stopped or unavailable app fails the operation. A new backup does not prove that the entire installation has been restored successfully.

## Scheduling and retention

```sh
python3 scripts/backup-schedule.py --directory /secure/openboard-backups --encrypt-to /secure/openboard-keys/recipient.pem --interval-hours 24 --keep 7
```

The directory must belong to the operator and be private (0700). The worker locks it to prevent overlapping schedulers. `--once` performs one cycle for an external timer. `backup-status.json` records the latest attempt and last successful backup without subprocess stderr or credentials. The worker is explicitly started by an operator; Compose does not start it automatically.

Retention deletes only recognized artifact/manifest pairs whose checksums verify, and preserves at least one. Unknown, corrupt or incomplete files remain for investigation. Checksum verification does not establish that an old private key remains available: periodically run an actual recovery drill. Use a separate, explicitly configured mechanism for off-host copies; none is enabled automatically.

## Complete installation capture

```sh
python3 scripts/backup.py --output backups/installation.tar.cms --encrypt-to /secure/openboard-keys/recipient.pem --include-proxy --maintenance
```

This explicit maintenance operation stops the project's currently running app and NPM, captures application data and NPM's `/data` and `/etc/letsencrypt`, then restarts only services that were previously running. It causes downtime. Capture fails if NPM is unavailable. Do not run while additional application replicas can still write. The bundle includes a contents inventory and is always encrypted. Deployment environment/secrets files remain separate and must be retained privately by the administrator.

SIGTERM/SIGINT unwind maintenance cleanup; scheduler timeouts allow a grace period. Forced process/host termination can still interrupt cleanup: check service state after a host failure or forced kill. The default backup command remains an application-only snapshot; it does not silently enter maintenance mode.

## Disposable recovery verification

```sh
python3 scripts/restore-check.py backups/installation.tar.cms --decrypt-key /secure/openboard-keys/private.pem
```

Build the current project images first. The checker uses `--pull=never`, unique container/network names, fresh databases and no existing Compose environment or volume. It migrates a copy offline, imports into fresh PostgreSQL/MongoDB, rehydrates a second cold cache and compares logical fingerprints for all application tables. NPM restoration is checked in a separate network-disabled container without starting NPM or requesting certificates. Test resources are then removed. This verifies a disposable recovery path; it does not replace an existing deployment.

## Reproducible local workload

```sh
python3 scripts/benchmark.py --boards 5 --cards 100 --requests 1000 --concurrency 8
python3 scripts/benchmark.py --boards 5 --cards 100 --requests 1000 --concurrency 8 --max-p95-ms 500 --max-error-rate 0
```

The benchmark starts its own loopback-only, unauthenticated SQLite instance in a temporary directory, strips inherited `OPENBOARD_*` configuration and removes its data afterward. It never benchmarks an existing instance. Reports include the binary SHA-256, OS/architecture/CPU count, dataset, concurrency, request mix, status/error counts, throughput, peak child RSS and nearest-rank p50/p95/p99 latency. Request counts divisible by ten exercise the exact declared mix. Dataset setup and warm-up are excluded from timing. Failed budgets return exit code 1 with a JSON report; preparation failures return 2.

This is a reproducible local baseline, not an authenticated PostgreSQL/MongoDB capacity or high-availability measurement. Compare runs on equivalent hardware and datasets. The example 500ms budget is illustrative and is not a published OpenBoard service objective.
