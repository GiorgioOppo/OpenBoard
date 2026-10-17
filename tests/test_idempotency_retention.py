"""Explicit retry-window expiration, including rollback and default compatibility."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import unittest

import test_transport


class IdempotencyRetentionTests(unittest.TestCase):
    setUp = test_transport.TransportTests.setUp
    start = test_transport.TransportTests.start
    stop = test_transport.TransportTests.stop
    request = test_transport.TransportTests.request

    def sql(self, query):
        with sqlite3.connect(Path(self.temp.name) / "test.db") as connection:
            return connection.execute(query).fetchall()

    def create(self):
        status, headers, data = self.request("POST", "/api/boards", json.dumps({"name": "Retry window"}),
            {"Content-Type": "application/json", "Idempotency-Key": "synthetic-retention-key"})
        self.assertEqual(status, 201, data)
        return json.loads(data), headers

    def test_unlimited_default_preserves_old_replays(self):
        first, _ = self.create()
        self.sql("UPDATE idempotency SET created_at='2000-01-01T00:00:00.000Z'")
        second, headers = self.create()
        self.assertEqual(second, first)
        self.assertEqual(headers.get("Idempotency-Replayed"), "true")

    def test_expired_keys_allow_new_action_and_cleanup_commits_with_success(self):
        self.stop()
        self.start("--idempotency-ttl", "300")
        first, _ = self.create()
        fresh, headers = self.create()
        self.assertEqual(fresh, first)
        self.assertEqual(headers.get("Idempotency-Replayed"), "true")
        self.sql("UPDATE idempotency SET created_at='2000-01-01T00:00:00.000Z'")
        second, headers = self.create()
        self.assertNotEqual(second["id"], first["id"])
        self.assertNotIn("Idempotency-Replayed", headers)
        self.assertEqual(self.sql("SELECT count(*) FROM idempotency"), [(1,)])

    def test_cleanup_rolls_back_with_rejected_mutation(self):
        self.stop()
        self.start("--idempotency-ttl", "300")
        self.create()
        self.sql("UPDATE idempotency SET created_at='2000-01-01T00:00:00.000Z'")
        status, _, _ = self.request("POST", "/api/boards", '{"name":""}', {"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertEqual(self.sql("SELECT count(*) FROM idempotency"), [(1,)])

    def test_invalid_ttl_configuration_fails_without_creating_a_database(self):
        environment = {key: value for key, value in os.environ.items() if not key.startswith("OPENBOARD_")}
        for value in ("bad", "-1", "31536001", "", "01"):
            environment["OPENBOARD_IDEMPOTENCY_TTL"] = value
            result = subprocess.run([str(test_transport.BINARY), "--diagnostics"], env=environment,
                                    capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0, value)


if __name__ == "__main__":
    unittest.main()
