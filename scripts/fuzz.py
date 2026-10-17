#!/usr/bin/env python3
"""Build real C parser targets and run bounded, isolated libFuzzer campaigns."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("http", "json", "unicode")
MAX_INPUT = 65536


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def environment() -> dict[str, str]:
    # Neither target executes the application CLI, opens deployment files or
    # contacts stores. Also remove inherited application configuration.
    result = {key: value for key, value in os.environ.items()
              if not key.startswith("OPENBOARD_")}
    result["ASAN_OPTIONS"] = "abort_on_error=1:detect_leaks=" + ("1" if sys.platform.startswith("linux") else "0")
    result["UBSAN_OPTIONS"] = "halt_on_error=1:print_stacktrace=1"
    return result


def private_text(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o600)


def build(compiler: list[str], output: Path, targets: list[str], env: dict) -> dict:
    flags = ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Wpedantic",
             "-D_POSIX_C_SOURCE=200809L", "-fno-omit-frame-pointer",
             "-fsanitize=fuzzer-no-link,address,undefined"]
    flags += shlex.split(subprocess.check_output(
        ["pkg-config", "--cflags", "openssl"], text=True, env=env, timeout=15))
    libraries = ["-lsqlite3", "-pthread", *shlex.split(subprocess.check_output(
        ["pkg-config", "--libs", "openssl"], text=True, env=env, timeout=15))]
    compiler_version = subprocess.check_output([*compiler, "--version"], text=True, env=env, timeout=15).splitlines()[0]
    sources = sorted((ROOT / "src").glob("*.c"))
    commands = []

    def compile_command(command: list[str]) -> None:
        commands.append(command)
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired as error:
            partial = "Compiler exceeded its deadline.\n"
            for value in (error.stdout, error.stderr):
                if value:
                    partial += value.decode(errors="replace") if isinstance(value, bytes) else value
            private_text(output / "build.log", (output / "build.log").read_text() + partial)
            raise RuntimeError("Fuzzer compilation timed out; inspect build.log.") from None
        private_text(output / "build.log", (output / "build.log").read_text() + result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError("Fuzzer compilation failed; inspect build.log. Use Clang with the libFuzzer runtime (Homebrew LLVM on macOS).")

    private_text(output / "build.log", "")
    if any(target != "http" for target in targets):
        compile_command([*compiler, *flags, "-Dmain=openboard_fuzz_json_cli", "-c",
                         str(ROOT / "src/http.c"), "-o", str(output / "http-cli.o")])
    for target in targets:
        omitted = {"http.c", "server.c"} if target == "json" else {"http.c"}
        command = [*compiler, *flags, "-fsanitize=fuzzer,address,undefined",
                   str(ROOT / "fuzz" / f"{target}.c"),
                   *(str(path) for path in sources if path.name not in omitted)]
        if target != "http":
            command.append(str(output / "http-cli.o"))
        compile_command([*command, "-o", str(output / target), *libraries])
    return {"compiler": compiler_version, "commands": commands,
            "binaries": {target: digest(output / target) for target in targets}}


def seed_corpus(output: Path, target: str) -> Path:
    source = json.loads((ROOT / "fuzz/corpus.json").read_text())
    seeds = source.get(target)
    if source.get("version") != 1 or not isinstance(seeds, dict) or not 1 <= len(seeds) <= 128:
        raise ValueError("Invalid synthetic seed corpus")
    corpus = output / "corpus" / target
    corpus.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, text in seeds.items():
        if not re.fullmatch(r"[a-z0-9-]{1,80}", name) or not isinstance(text, str):
            raise ValueError("Invalid synthetic seed name/text")
        data = text.encode("utf-8")
        if len(data) > MAX_INPUT:
            raise ValueError("Synthetic seed exceeds input bound")
        destination = corpus / ("seed-" + name)
        destination.write_bytes(data)
        destination.chmod(0o600)
    # The committed corpus is never writable by libFuzzer. Generated inputs
    # and previous minimized examples remain only in the ignored output tree.
    return corpus


def campaign(output: Path, target: str, args, env: dict) -> dict:
    artifacts = output / "artifacts" / target
    artifacts.mkdir(parents=True, exist_ok=True, mode=0o700)
    command = [str(output / target), "-max_len=" + str(MAX_INPUT), "-timeout=3",
               "-rss_limit_mb=512", "-error_exitcode=77", "-timeout_exitcode=78",
               "-oom_exitcode=79", "-artifact_prefix=" + str(artifacts) + os.sep]
    if args.replay:
        command += [str(args.replay.resolve()), "-runs=1"]
    else:
        command += [str(seed_corpus(output, target)), "-dict=" + str(ROOT / "fuzz" / f"{target}.dict"),
                    "-seed=" + str(args.seed), "-runs=" + str(args.runs),
                    "-max_total_time=" + str(args.seconds), "-print_final_stats=1"]
    started = time.monotonic()
    try:
        process = subprocess.run(command, cwd=output, env=env, capture_output=True, text=True,
                                 timeout=args.seconds + 30)
        log = process.stdout + process.stderr
        code = process.returncode
    except subprocess.TimeoutExpired as error:
        log = "Campaign exceeded its outer deadline.\n"
        for value in (error.stdout, error.stderr):
            if value:
                log += value.decode(errors="replace") if isinstance(value, bytes) else value
        code = 124
    private_text(output / f"{target}.log", log)
    stats = {key: int(value) for key, value in re.findall(r"stat::(number_of_executed_units|new_units_added|peak_rss_mb):\s*(\d+)", log)}
    final = re.findall(r"#\d+\s+DONE\s+cov:\s*(\d+)\s+ft:\s*(\d+)", log)
    if final:
        stats.update(coverage_edges=int(final[-1][0]), features=int(final[-1][1]))
    return {"target": target, "exit_code": code, "elapsed_seconds": round(time.monotonic() - started, 3),
            "stats": stats, "command": command,
            "artifact_files": sorted(path.name for path in artifacts.iterdir() if path.is_file())}


def positive(value: str) -> int:
    number = int(value)
    if not 1 <= number <= 10_000_000:
        raise argparse.ArgumentTypeError("use an integer from 1 to 10000000")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cc", default=os.environ.get("FUZZ_CC", "clang"))
    parser.add_argument("--output", type=Path, default=ROOT / "build/fuzz")
    parser.add_argument("--target", choices=(*TARGETS, "all"), default="all")
    parser.add_argument("--seconds", type=positive, default=15)
    parser.add_argument("--runs", type=positive, default=10000)
    parser.add_argument("--seed", type=int, default=20261017)
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--replay", type=Path)
    args = parser.parse_args()
    if args.seconds > 3600 or not 0 <= args.seed <= 4294967295:
        parser.error("seconds must be at most 3600; seed must fit an unsigned 32-bit integer")
    if args.replay and (args.target == "all" or not args.replay.is_file() or args.replay.stat().st_size > MAX_INPUT):
        parser.error("replay requires one target and a regular input file of at most 64 KiB")
    compiler = shlex.split(args.cc)
    if not compiler:
        parser.error("a Clang compiler is required")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    targets = list(TARGETS) if args.target == "all" else [args.target]
    env = environment()
    inputs = sorted((ROOT / "src").glob("*.[ch]")) + sorted((ROOT / "fuzz").glob("*")) + [ROOT / "scripts/fuzz.py", ROOT / "Makefile"]
    if (ROOT / "vendor").is_dir():
        inputs += sorted(path for path in (ROOT / "vendor").rglob("*") if path.is_file())
    report = {"version": 1, "platform": platform.system(), "machine": platform.machine(),
              "storage": "isolated SQLite in memory; no external stores",
              "input_limit_bytes": MAX_INPUT, "seed": args.seed,
              "source_sha256": {str(path.relative_to(ROOT)): digest(path) for path in inputs if path.is_file()},
              "results": []}
    try:
        report["build"] = build(compiler, output, targets, env)
        if not args.build_only:
            for target in targets:
                result = campaign(output, target, args, env)
                report["results"].append(result)
                print(f"{target}: exit={result['exit_code']}, {result['stats']}", flush=True)
                if result["exit_code"]:
                    return 1
        return 0
    except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as error:
        report["error"] = str(error)
        print("Fuzz check failed: " + str(error), file=sys.stderr)
        return 1
    finally:
        private_text(output / "report.json", json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
