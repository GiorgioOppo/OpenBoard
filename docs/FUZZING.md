# Native fuzzing

The development branch includes three coverage-guided [LLVM libFuzzer](https://llvm.org/docs/LibFuzzer.html) targets with AddressSanitizer and UndefinedBehaviorSanitizer. These exercise real production C helpers. They do not execute the application CLI, create users, modify deployment files or contact PostgreSQL/MongoDB. The HTTP target uses Unix socket pairs without a TCP listener; the JSON and Unicode targets use isolated SQLite databases in memory.

| Target | Exercised code and checks |
| --- | --- |
| `http` | Actual HTTP request/header/body parser, percent decoding, duplicate query parameters and canonical proxy client addresses. Checks output bounds, valid UTF-8, control-character rejection and canonical address stability. Trusted-proxy/public-origin branches have synthetic seeds. |
| `json` | Actual UTF-8, ID/date and typed JSON validators, duplicate root/custom keys, checklist and numeric-assignee validation. Checks successful string/type/range contracts. |
| `unicode` | Actual Unicode SQL functions, normalization/case-folding, original-text offset mapping and excerpt slicing. Checks valid/invalid input results, self-matching, original substrings and the 240-code-point excerpt bound. |

## Prerequisites and bounded checks

Install Clang with the libFuzzer runtime, SQLite/OpenSSL development headers, `pkg-config` and Python. Apple Command Line Tools may not ship the fuzzer runtime; Homebrew LLVM is suitable. No npm packages, external stores or Docker are required. The fuzzer build uses local SQLite mode even if the normal build enables external storage.

```sh
make fuzz-smoke

# macOS when the system Clang has no libFuzzer runtime:
FUZZ_CC="$(brew --prefix llvm)/bin/clang" make fuzz-smoke

# Compile without executing a campaign:
make fuzz-build
```

Each default campaign stops after 10,000 executions or approximately 15 seconds, whichever occurs first. Inputs are limited to 64 KiB, with a three-second per-input timeout, a 512 MiB RSS budget and a separate outer process deadline. These bounds are test budgets, not new production HTTP limits. The JSON and Unicode databases never leave memory. Inherited `OPENBOARD_*` settings are removed; sanitizer options are set explicitly. Leak checks are enabled on Linux; macOS runs ASan/UBSan without LeakSanitizer.

To extend a local campaign, keep the bounds explicit:

```sh
python3 scripts/fuzz.py --target unicode --runs 1000000 --seconds 30
python3 scripts/fuzz.py --target http --runs 1000000 --seconds 30
python3 scripts/fuzz.py --target json --runs 1000000 --seconds 30
```

The default seed is `20261017`. A fixed seed aids investigation but does not promise identical generated inputs across compilers, platforms or corpus histories. Record the report and exact failing input.

## Corpus, results and reproduction

[corpus.json](../fuzz/corpus.json) contains only synthetic seeds, including malformed requests, duplicate fields, Unicode and wrong JSON types. Dictionaries live in [fuzz/](../fuzz/). The runner copies seeds to an ignored output tree; libFuzzer never writes to the committed seed file. Later runs may reuse generated inputs already in that output tree. Use a fresh `--output` directory when a fresh corpus is required.

The default `build/fuzz/` tree contains private build/campaign logs, generated corpora, crash/timeout inputs and `report.json`. The report records exact source and binary SHA-256 hashes, compiler/architecture, commands, exit statuses and available execution/coverage statistics. Coverage counts describe instrumented edges/features, not a percentage of all application code. These outputs are ignored by Git. Keep real user data and credentials out of all corpora and artifacts.

Reproduce a saved input with the same source/toolchain:

```sh
python3 scripts/fuzz.py --target unicode --replay build/fuzz/artifacts/unicode/crash-INPUT_HASH
```

Choose the target that produced the input. Replay executes that input without a mutation campaign and returns failure when the target fails. A nonzero target exit, sanitizer report, timeout or memory limit fails the runner; it is not counted as a passing check. Preserve the original artifact, minimize it in a separate output directory, and add a focused behavioral regression after fixing the cause.

The separate **Native fuzzing** CI job builds all three targets with Clang and runs the bounded checks. It retains only reports, logs and synthetic failure inputs for seven days. It never uploads deployment environment files, databases, compiler binaries or the complete build directory. This new job requires runtime confirmation for each published candidate.

## Scope of the evidence

Short bounded campaigns supplement the [ordinary and sanitizer suites](TESTING.md); they do not replace permission/integration tests. They are not a long-running fuzzing campaign, an independent penetration test, a complete application/SQL-engine coverage assessment or a security certification. Authenticated workflows, external drivers and the full HTTP request-to-mutation path remain covered by their separate tests. The original dated security audit keeps its historical findings unchanged.
