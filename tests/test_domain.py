#!/usr/bin/env python3
"""Domain invariants, rollback, migration and recovery integration tests."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import sqlite3
import subprocess
import unittest

import test_api
from test_api import BINARY, ROOT


class OpenBoardDomain(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api
    create_board = test_api.OpenBoardAPI.create_board
    create_card = test_api.OpenBoardAPI.create_card
    board = test_api.OpenBoardAPI.board
    assert_card_order = test_api.OpenBoardAPI.assert_card_order

    def test_revisions_summary_and_atomic_optimistic_concurrency(self):
        board = self.create_board(starred=True)
        self.assertTrue(board["starred"])
        column = board["columns"][0]["id"]
        card = self.create_card(column, "Revision", description="Descrizione " * 400,
                                checklist=[{"id": "a", "text": "Prima", "done": True},
                                           {"id": "b", "text": "Seconda", "done": False}])
        full = self.api("GET", f"/api/cards/{card}")
        datetime.fromisoformat(full["created_at"].replace("Z", "+00:00"))
        self.assertGreaterEqual(full["version"], 1)
        summary = self.api("GET", f"/api/boards/{board['id']}?summary=1")["columns"][0]["cards"][0]
        self.assertNotIn("description", summary)
        self.assertNotIn("checklist", summary)
        self.assertEqual(summary["checklist_total"], 2)
        self.assertEqual(summary["checklist_done"], 1)
        self.assertLessEqual(len(summary["description_preview"]), 160)
        revision = self.api("GET", f"/api/boards/{board['id']}/revision")["version"]

        def edit(title):
            body = json.dumps({"title": title}).encode()
            return self.request("PATCH", f"/api/cards/{card}", body,
                                {"Content-Type": "application/json", "If-Match": f'"{full["version"]}"'})[0]

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(edit, ["First writer", "Second writer"])), [200, 412])
        self.assertGreater(self.api("GET", f"/api/boards/{board['id']}/revision")["version"], revision)
        self.assertGreater(self.api("GET", f"/api/cards/{card}")["version"], full["version"])
        current = self.board(board["id"])
        self.api("PATCH", f"/api/boards/{board['id']}", {"name": "Changed"},
                 headers={"If-Match": f'"{current["version"]}"'})
        self.api("PATCH", f"/api/boards/{board['id']}", {"name": "Stale"}, expected=412,
                 headers={"If-Match": f'"{current["version"]}"'})

    def test_soft_delete_hierarchy_safe_restore_and_persistence(self):
        board = self.create_board()
        bid, column = board["id"], board["columns"][0]["id"]
        card = self.create_card(column, "Recover me", description="Keep content")
        self.api("DELETE", f"/api/cards/{card}")
        self.api("DELETE", f"/api/columns/{column}")
        self.api("DELETE", f"/api/boards/{bid}")
        self.api("GET", f"/api/cards/{card}", expected=404)
        items = self.api("GET", "/api/trash")["items"]
        self.assertIn(("cards", card), [(x["kind"], x["id"]) for x in items])
        self.api("POST", f"/api/cards/{card}/restore", {}, expected=409)
        self.api("POST", f"/api/columns/{column}/restore", {}, expected=409)
        self.api("POST", f"/api/trash/boards/{bid}/restore", {})
        self.api("POST", f"/api/cards/{card}/restore", {}, expected=409)
        self.api("POST", f"/api/columns/{column}/restore", {})
        self.api("POST", f"/api/cards/{card}/restore", {})
        self.assertEqual(self.api("GET", f"/api/cards/{card}")["description"], "Keep content")
        self.assert_card_order(bid, column, [card])
        self.stop_server()
        self.start_server()
        self.assertEqual(self.api("GET", f"/api/cards/{card}")["title"], "Recover me")

    def test_archives_duplicate_and_metadata(self):
        board = self.create_board("C" * 200)
        bid, col = board["id"], board["columns"][0]["id"]
        card = self.create_card(col, "High priority", labels=["design", "urgente"],
                                priority="urgent", estimate_minutes=90)
        self.api("PATCH", f"/api/cards/{card}", {"archived": True})
        self.assertEqual(self.board(bid)["columns"][0]["cards"], [])
        full = self.api("GET", f"/api/boards/{bid}?include_archived=1")
        self.assertTrue(full["columns"][0]["cards"][0]["archived"])
        duplicate = self.api("POST", f"/api/cards/{card}/duplicate", {}, expected=201)
        clone = self.api("GET", f"/api/cards/{duplicate['id']}")
        self.assertEqual(clone["labels"], ["design", "urgente"])
        self.assertEqual(clone["estimate_minutes"], 90)
        copied = self.api("POST", f"/api/boards/{bid}/duplicate", {"name": "Copy"}, expected=201)
        copied_board = self.api("GET", f"/api/boards/{copied['id']}?include_archived=1")
        self.assertEqual(copied_board["name"], "Copy")
        self.assertEqual(len(copied_board["columns"][0]["cards"]), 2)
        default_copy = self.api("POST", f"/api/boards/{bid}/duplicate", {}, expected=201)
        default_copy_name = self.board(default_copy["id"])["name"]
        self.assertLessEqual(len(default_copy_name), 200)
        self.assertEqual(default_copy_name, "C" * 192 + " (copia)")
        self.assertTrue(default_copy_name.endswith(" (copia)"))
        self.api("PATCH", f"/api/boards/{bid}", {"archived": True})
        self.assertNotIn(bid, [x["id"] for x in self.api("GET", "/api/boards")["boards"]])
        self.assertIn(bid, [x["id"] for x in self.api("GET", "/api/boards?include_archived=1")["boards"]])
        for payload in ({"priority": "bad"}, {"labels": ["design", "design"]},
                        {"labels": ["unknown"]}, {"estimate_minutes": -1}):
            self.api("PATCH", f"/api/cards/{card}", payload, expected=400)

    def test_wip_limits_create_move_reopen_and_rollback(self):
        board = self.create_board()
        bid, source, target = board["id"], board["columns"][0]["id"], board["columns"][1]["id"]
        self.api("PATCH", f"/api/columns/{target}", {"wip_limit": 1})
        occupied = self.create_card(target, "Occupied")
        incoming = self.create_card(source, "Incoming")
        before = self.board(bid)
        self.api("POST", f"/api/columns/{target}/cards", {"title": "Too much"}, expected=409)
        self.api("PATCH", f"/api/cards/{incoming}", {"column_id": target}, expected=409)
        self.assertEqual(self.board(bid), before)
        finished = self.create_card(target, "Done does not count", completed=True)
        self.api("PATCH", f"/api/cards/{finished}", {"completed": False}, expected=409)
        self.api("PATCH", f"/api/cards/{occupied}", {"archived": True})
        self.api("PATCH", f"/api/cards/{incoming}", {"column_id": target})
        self.api("PATCH", f"/api/cards/{occupied}", {"archived": False}, expected=409)
        self.api("PATCH", f"/api/cards/{incoming}", {"completed": True})
        self.api("PATCH", f"/api/cards/{occupied}", {"archived": False})

    def test_column_order_versions_and_invalid_position(self):
        board = self.create_board()
        bid = board["id"]
        last = board["columns"][-1]
        self.api("PATCH", f"/api/columns/{last['id']}", {"position": 0},
                 headers={"If-Match": f'"{last["version"]}"'})
        moved = self.board(bid)["columns"]
        self.assertEqual(moved[0]["id"], last["id"])
        self.assertEqual([c["position"] for c in moved], [0, 1, 2])
        self.api("PATCH", f"/api/columns/{last['id']}", {"title": "Stale"}, expected=412,
                 headers={"If-Match": f'"{last["version"]}"'})
        snapshot = self.board(bid)
        self.api("PATCH", f"/api/columns/{last['id']}", {"position": 50}, expected=400)
        self.assertEqual(self.board(bid), snapshot)

    def test_comments_activity_search_and_stats(self):
        demo = self.api("GET", "/api/boards")["boards"][0]
        demo_stats = self.api("GET", f"/api/boards/{demo['id']}/stats")
        self.assertEqual(sum(demo_stats["by_label"].values()), demo_stats["total"])
        self.assertGreater(demo_stats["total"], 0)
        board = self.create_board()
        bid, col = board["id"], board["columns"][0]["id"]
        card = self.create_card(col, "Find café", description="Search needle", labels=["design", "urgente"],
                                assignee="Ada", due_date="2000-01-01", priority="high")
        self.create_card(col, "Completed", completed=True, label="design")
        before = self.api("GET", f"/api/boards/{bid}/revision")["version"]
        comment = self.api("POST", f"/api/cards/{card}/comments", {"body": "Discussione <b>test</b>"}, expected=201)
        comments = self.api("GET", f"/api/cards/{card}/comments")["comments"]
        self.assertEqual(comments[0]["body"], "Discussione <b>test</b>")
        self.assertEqual(comments[0]["author"], "Locale")
        self.assertGreater(self.api("GET", f"/api/boards/{bid}/revision")["version"], before)
        search = self.api("GET", "/api/search?q=Search%20needle")["cards"]
        self.assertEqual([c["id"] for c in search], [card])
        self.assertEqual(self.api("GET", "/api/search?q=caf%C3%A9")["cards"][0]["id"], card)
        stats = self.api("GET", f"/api/boards/{bid}/stats")
        self.assertEqual((stats["total"], stats["completed"], stats["overdue"]), (2, 1, 1))
        self.assertEqual(stats["by_label"], {"design": 2, "urgente": 1})
        self.assertEqual(stats["by_assignee"]["Ada"], 1)
        self.api("DELETE", f"/api/comments/{comment['id']}")
        self.assertEqual(self.api("GET", f"/api/cards/{card}/comments")["comments"], [])
        events = self.api("GET", f"/api/boards/{bid}/activity")["events"]
        self.assertIn("commented", [x["action"] for x in events])
        self.assertIn("comment_deleted", [x["action"] for x in events])
        self.api("POST", f"/api/cards/{card}/comments", {"body": " "}, expected=400)

    def test_idempotency_parallel_atomic_repeat_and_mismatch(self):
        board = self.create_board()
        col = board["columns"][0]["id"]
        path = f"/api/columns/{col}/cards"
        body = json.dumps({"title": "Only once"}).encode()
        headers = {"Content-Type": "application/json", "Idempotency-Key": "repeat-1"}

        def create(_):
            status, response_headers, response_body = self.request("POST", path, body, headers)
            return status, response_headers, json.loads(response_body)

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(create, range(4)))
        self.assertTrue(all(r[0] == 201 for r in results), results)
        self.assertEqual(len({r[2]["id"] for r in results}), 1)
        self.assertEqual(len(self.board(board["id"])["columns"][0]["cards"]), 1)
        self.assertEqual(sum("idempotency-replayed" in r[1] for r in results), 3)
        self.api("POST", path, {"title": "Different body"}, expected=409,
                 headers={"Idempotency-Key": "repeat-1"})
        self.assertEqual(len(self.board(board["id"])["columns"][0]["cards"]), 1)

    def test_export_import_roundtrip_and_atomic_invalid_import(self):
        board = self.create_board("Import me", description="Roundtrip")
        col = board["columns"][0]["id"]
        self.create_card(col, "Archived too", archived=True, priority="urgent", labels=["urgente"],
                         checklist=[{"id": "x", "text": "Check", "done": False}], estimate_minutes=60)
        exported = self.api("GET", f"/api/boards/{board['id']}/export")
        self.assertEqual((exported["format"], exported["version"]), ("openboard", 2))
        self.assertEqual(len(exported["board"]["columns"][0]["cards"]), 1)
        imported = self.api("POST", "/api/import", exported, expected=201)
        copy = self.api("GET", f"/api/boards/{imported['id']}?include_archived=1")
        self.assertEqual(copy["description"], "Roundtrip")
        self.assertEqual(copy["columns"][0]["cards"][0]["estimate_minutes"], 60)
        self.assertTrue(copy["columns"][0]["cards"][0]["archived"])
        count = len(self.api("GET", "/api/boards")["boards"])
        exported["board"]["columns"][-1]["cards"] = [{"title": "Good"}, {"title": " ", "priority": "bad"}]
        self.api("POST", "/api/import", exported, expected=400)
        self.assertEqual(len(self.api("GET", "/api/boards")["boards"]), count)
        self.api("POST", "/api/import", {"format": "openboard", "version": 500, "board": {}}, expected=400)

    def test_archived_cards_do_not_distort_visible_order(self):
        board = self.create_board()
        bid, col = board["id"], board["columns"][0]["id"]
        archived = self.create_card(col, "Archive first")
        first = self.create_card(col, "First visible")
        second = self.create_card(col, "Second visible")
        self.api("PATCH", f"/api/cards/{archived}", {"archived": True})
        self.assert_card_order(bid, col, [first, second])
        self.api("PATCH", f"/api/cards/{first}", {"position": 1})
        self.assert_card_order(bid, col, [second, first])
        third = self.create_card(col, "Third visible")
        self.assert_card_order(bid, col, [second, first, third])
        self.assertEqual(self.api("GET", f"/api/cards/{first}")["label"], "")
        self.api("PATCH", f"/api/cards/{first}", {"labels": ["design", "urgente"]})
        self.assertEqual(self.api("GET", f"/api/cards/{first}")["label"], "design")
        self.api("PATCH", f"/api/cards/{first}", {"labels": []})
        self.assertEqual(self.api("GET", f"/api/cards/{first}")["label"], "")

    def test_database_request_failure_is_recoverable_and_atomic(self):
        board = self.create_board()
        bid, col = board["id"], board["columns"][0]["id"]
        revision = self.api("GET", f"/api/boards/{bid}/revision")["version"]
        with sqlite3.connect(self.db) as conn:
            conn.execute("CREATE TRIGGER injected_failure BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT,'Injected storage failure');END")
        self.api("POST", f"/api/columns/{col}/cards", {"title": "Must roll back"}, expected=503)
        self.assertEqual(self.api("GET", f"/api/boards/{bid}/revision")["version"], revision)
        with sqlite3.connect(self.db) as conn:
            conn.execute("DROP TRIGGER injected_failure")
            conn.execute("ALTER TABLE cards RENAME TO temporarily_unavailable")
        self.api("POST", f"/api/columns/{col}/cards", {"title": "Prepare must recover"}, expected=503)
        with sqlite3.connect(self.db) as conn:
            conn.execute("ALTER TABLE temporarily_unavailable RENAME TO cards")
        created = self.create_card(col, "Recovered normally")
        self.assert_card_order(bid, col, [created])
        self.assertIsNone(self.process.poll())

    def test_online_backup_migration_and_future_schema_rejection(self):
        self.create_board("Preserved backup")
        backup = self.directory / "backup.sqlite3"
        proc = subprocess.run([str(BINARY), "--db", str(self.db), "--backup", str(backup)],
                              cwd=ROOT, capture_output=True, timeout=8)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with sqlite3.connect(backup) as conn:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(conn.execute("SELECT name FROM boards WHERE name='Preserved backup'").fetchone()[0], "Preserved backup")
        legacy = self.directory / "legacy.sqlite3"
        with sqlite3.connect(legacy) as conn:
            conn.executescript("""
              PRAGMA user_version=1;
              CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
              INSERT INTO metadata VALUES('initialized','1');
              CREATE TABLE boards(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT 'sage',starred INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE columns(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id INTEGER NOT NULL REFERENCES boards(id),title TEXT NOT NULL,position INTEGER NOT NULL);
              CREATE TABLE cards(id INTEGER PRIMARY KEY AUTOINCREMENT,column_id INTEGER NOT NULL REFERENCES columns(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',label TEXT NOT NULL DEFAULT '',due_date TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL DEFAULT '',cover TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0,checklist TEXT NOT NULL DEFAULT '[]');
              INSERT INTO boards(id,name)VALUES(42,'Legacy preserved');
              INSERT INTO columns(id,board_id,title,position)VALUES(7,42,'Original list',0);
              INSERT INTO cards(column_id,title,label,position)VALUES(7,'Original card','design',0);
            """)
        migrated_backup = self.directory / "migrated.sqlite3"
        proc = subprocess.run([str(BINARY), "--db", str(legacy), "--no-demo", "--backup", str(migrated_backup)],
                              cwd=ROOT, capture_output=True, timeout=8)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(legacy.with_name(legacy.name + ".pre-v1.bak").exists())
        with sqlite3.connect(legacy) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 5)
            self.assertEqual(conn.execute("SELECT count(*) FROM boards").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT labels FROM cards").fetchone()[0], '["design"]')
            self.assertTrue(conn.execute("SELECT created_at FROM cards").fetchone()[0])
            conn.execute("PRAGMA user_version=999")
        proc = subprocess.run([str(BINARY), "--db", str(legacy), "--backup", str(migrated_backup)],
                              cwd=ROOT, capture_output=True, timeout=8)
        self.assertNotEqual(proc.returncode, 0)
        with sqlite3.connect(legacy) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 999)


if __name__ == "__main__":
    unittest.main(verbosity=2)
