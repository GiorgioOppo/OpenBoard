"""Run actual bounded workload measurements against an isolated C server."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import runpy

import test_transport

ROOT = Path(__file__).resolve().parents[1]


class BenchmarkTests(unittest.TestCase):
    def run_benchmark(self, *arguments):
        return subprocess.run([sys.executable, str(ROOT / "scripts/benchmark.py"),
            "--binary", os.environ.get("OPENBOARD_BINARY", str(ROOT / "build/openboard")),
            "--boards", "1", "--cards", "3", "--requests", "20", "--concurrency", "2", "--warmup", "2",
            *arguments], capture_output=True, timeout=30)

    def test_actual_workload_reports_identity_distribution_and_success(self):
        result = self.run_benchmark()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["dataset"]["cards"], 3)
        self.assertEqual(report["requests"], 20)
        self.assertEqual(report["errors"], 0)
        self.assertEqual(report["violations"], [])
        self.assertEqual(sum(report["status_counts"].values()), 20)
        self.assertEqual(len(report["binary_sha256"]), 64)
        self.assertTrue(report["isolated"])
        self.assertEqual(report["storage"], "sqlite")
        self.assertLessEqual(report["latency_ms"]["p50"], report["latency_ms"]["p95"])
        self.assertLessEqual(report["latency_ms"]["p95"], report["latency_ms"]["p99"])

    def test_impossible_latency_budget_returns_failed_report(self):
        result = self.run_benchmark("--max-p95-ms", "0.000000001")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("p95_latency_budget_exceeded", json.loads(result.stdout)["violations"])

    def test_invalid_measurement_parameters_fail_before_launch(self):
        for arguments in (("--requests", "0"), ("--concurrency", "1000"),
                          ("--max-p95-ms", "nan"), ("--max-error-rate", "-1")):
            result = self.run_benchmark(*arguments)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(result.stdout)


class BenchmarkHostIsolation(unittest.TestCase):
    setUp = test_transport.TransportTests.setUp
    start = test_transport.TransportTests.start
    stop = test_transport.TransportTests.stop
    request = test_transport.TransportTests.request

    def test_random_authority_cannot_prepare_data_in_another_backend(self):
        module = runpy.run_path(str(ROOT / 'scripts/benchmark.py'))
        before = self.request('GET', '/api/boards')[2]
        status, _ = module['call'](self.port, 'POST', '/api/boards', {'name': 'Must not create'},
                                   authority='benchmark-isolation-proof.localhost')
        self.assertEqual(status, 403)
        self.assertEqual(self.request('GET', '/api/boards')[2], before)


if __name__ == "__main__":
    unittest.main()
