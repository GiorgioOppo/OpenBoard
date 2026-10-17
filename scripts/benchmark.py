#!/usr/bin/env python3
"""Measure an isolated SQLite workload; never connect to an existing installation."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import resource
import secrets
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def call(port, method, path, payload=None, *, authority=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        body = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if authority is not None:
            headers["Host"] = authority
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def checked(port, method, path, payload=None, *, authority=None):
    status, body = call(port, method, path, payload, authority=authority)
    if status >= 400:
        raise RuntimeError("Dataset preparation failed")
    return json.loads(body)


def percentile(values, fraction):
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def benchmark(arguments):
    binary = arguments.binary.resolve(strict=True)
    with binary.open("rb") as stream:
        binary_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    environment = {key: value for key, value in os.environ.items() if not key.startswith("OPENBOARD_")}
    with tempfile.TemporaryDirectory(prefix="openboard-benchmark-") as directory:
        folder = Path(directory)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        # A random Host is accepted only by this temporary process. If another
        # listener races to claim the released port, its Host validation rejects
        # preparation requests instead of modifying an unrelated local board.
        authority = f"benchmark-{secrets.token_hex(16)}.localhost:{port}"
        with (folder / "server.log").open("w+b") as log:
            process = subprocess.Popen([str(binary), "--db", str(folder / "data.sqlite3"),
                "--port", str(port), "--public-url", f"http://{authority}",
                "--no-auth", "--no-demo", "--quiet"],
                env=environment, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("Temporary server exited")
                    try:
                        if call(port, "GET", "/api/health", authority=authority)[0] == 200:
                            break
                    except (OSError, http.client.HTTPException):
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Temporary server startup timed out")
                    time.sleep(0.025)
                version = checked(port, "GET", "/api/version", authority=authority)
                boards, cards = [], []
                for board_index in range(arguments.boards):
                    board = checked(port, "POST", "/api/boards",
                                    {"name": f"Benchmark board {board_index}", "language": "en"}, authority=authority)
                    detail = checked(port, "GET", f"/api/boards/{board['id']}", authority=authority)
                    boards.append(board["id"])
                    column = detail["columns"][0]["id"]
                    for card_index in range(arguments.cards):
                        card = checked(port, "POST", f"/api/columns/{column}/cards",
                            {"title": f"Benchmark needle {card_index}", "description": "Synthetic workload " * 20}, authority=authority)
                        cards.append(card["id"])
                for _ in range(arguments.warmup):
                    checked(port, "GET", f"/api/boards/{boards[0]}", authority=authority)

                def sample(index):
                    # 20% board list, 30% board detail, 20% card detail,
                    # 20% paginated search and 10% content writes.
                    position = index % 10
                    method, payload = "GET", None
                    if position < 2:
                        path = "/api/boards"
                    elif position < 5:
                        path = f"/api/boards/{boards[index % len(boards)]}"
                    elif position < 7:
                        path = f"/api/cards/{cards[index % len(cards)]}"
                    elif position < 9:
                        path = "/api/search?q=needle&limit=30"
                    else:
                        method = "PATCH"
                        path = f"/api/cards/{cards[index % len(cards)]}"
                        payload = {"description": f"Synthetic update {index}"}
                    started = time.perf_counter()
                    try:
                        status, body = call(port, method, path, payload, authority=authority)
                        size = len(body)
                    except (OSError, http.client.HTTPException):
                        status, size = 0, 0
                    return (time.perf_counter() - started) * 1000, status, size

                started = time.perf_counter()
                with ThreadPoolExecutor(max_workers=arguments.concurrency) as pool:
                    samples = list(pool.map(sample, range(arguments.requests)))
                elapsed = time.perf_counter() - started
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    latencies = sorted(item[0] for item in samples)
    errors = sum(item[1] == 0 or item[1] >= 400 for item in samples)
    rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    report = {
        "format": "openboard-benchmark", "format_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "storage": "sqlite", "authenticated": False, "isolated": True,
        "binary_sha256": binary_hash, "application_version": version["version"],
        "hardware": {"os": platform.system(), "release": platform.release(),
                     "architecture": platform.machine(), "logical_cpus": os.cpu_count()},
        "dataset": {"boards": len(boards), "cards": len(cards), "warmup_requests": arguments.warmup},
        "workload_percent": {"board_list": 20, "board_detail": 30, "card_detail": 20, "search": 20, "write": 10},
        "requests": len(samples), "concurrency": arguments.concurrency,
        "elapsed_seconds": elapsed, "requests_per_second": len(samples) / elapsed,
        "response_bytes": sum(item[2] for item in samples),
        "errors": errors, "error_rate": errors / len(samples),
        "latency_ms": {"method": "nearest_rank", "p50": percentile(latencies, .5),
                       "p95": percentile(latencies, .95), "p99": percentile(latencies, .99)},
        "server_max_rss_bytes": rss if sys.platform == "darwin" else rss * 1024,
        "status_counts": {str(code): sum(item[1] == code for item in samples)
                          for code in sorted({item[1] for item in samples})},
        "violations": [],
        "limitations": ["Isolated unauthenticated SQLite workload; not an external-storage or enterprise capacity claim.",
                        "Use request counts divisible by 10 for the exact declared workload mix."]
    }
    if arguments.max_p95_ms is not None and report["latency_ms"]["p95"] > arguments.max_p95_ms:
        report["violations"].append("p95_latency_budget_exceeded")
    if report["error_rate"] > arguments.max_error_rate:
        report["violations"].append("error_rate_budget_exceeded")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path(os.environ.get("OPENBOARD_BINARY", ROOT / "build/openboard")))
    parser.add_argument("--boards", type=int, default=5)
    parser.add_argument("--cards", type=int, default=100, help="Cards per board")
    parser.add_argument("--requests", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument("--max-p95-ms", type=float)
    parser.add_argument("--max-error-rate", type=float, default=0)
    arguments = parser.parse_args(argv)
    if (not 1 <= arguments.boards <= 100 or not 1 <= arguments.cards <= 10000 or
        arguments.boards * arguments.cards > 100000 or not 1 <= arguments.requests <= 100000 or
        not 1 <= arguments.concurrency <= 32 or not 0 <= arguments.warmup <= 1000 or
        not math.isfinite(arguments.max_error_rate) or not 0 <= arguments.max_error_rate <= 1 or
        (arguments.max_p95_ms is not None and
         (not math.isfinite(arguments.max_p95_ms) or arguments.max_p95_ms <= 0))):
        parser.error("Invalid dataset, concurrency, request count or performance budget")
    try:
        report = benchmark(arguments)
    except (OSError, RuntimeError, ValueError, http.client.HTTPException):
        print("Benchmark failed while preparing or running the isolated workload.", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["violations"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
