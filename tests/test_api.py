#!/usr/bin/env python3
"""Integration checks for OpenBoard. All state lives in temporary directories."""

import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("OPENBOARD_BINARY", ROOT / "build" / "openboard"))
TITLE_200 = "Caffè 🚀 " * 25
TITLE_300 = "Caffè 🚀 " * 37 + "idee"


class OpenBoardAPI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openboard-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.db = self.directory / "test.sqlite3"
        self.web = self.directory / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("<!doctype html><title>OpenBoard test</title>", encoding="utf-8")
        (self.web / "app.js").write_text("console.log('test');", encoding="utf-8")
        (self.web / "styles.css").write_text("body { color: teal; }", encoding="utf-8")
        (self.directory / "secret.txt").write_text("must never be served", encoding="utf-8")
        self.process = None
        self.log = (self.directory / "server.log").open("w+b")
        self.addCleanup(self.log.close)
        self.addCleanup(self.stop_server)
        self.start_server()

    def start_server(self):
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            self.port = reserve.getsockname()[1]
        self.process = subprocess.Popen(
            [str(BINARY), "--port", str(self.port), "--db", str(self.db), "--web-root", str(self.web)],
            stdout=self.log,
            stderr=subprocess.STDOUT,
            cwd=ROOT,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail("Server exited during startup:\n" + self.server_log())
            try:
                status, _, body = self.request("GET", "/api/health")
                if status == 200 and json.loads(body).get("status") == "ok":
                    return
            except (OSError, http.client.HTTPException, ValueError):
                pass
            time.sleep(0.025)
        self.fail("Server did not become ready:\n" + self.server_log())

    def stop_server(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.process = None

    def server_log(self):
        self.log.flush()
        return (self.directory / "server.log").read_text(encoding="utf-8", errors="replace")

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def api(self, method, path, payload=None, expected=200, headers=None):
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        status, response_headers, response_body = self.request(method, path, body, request_headers)
        self.assertEqual(status, expected, f"{method} {path}: {response_body!r}")
        self.assertIn("application/json", response_headers.get("content-type", ""))
        try:
            result = json.loads(response_body)
        except (ValueError, UnicodeError):
            self.fail(f"Invalid JSON response for {method} {path}: {response_body!r}")
        if expected >= 400:
            self.assertIsInstance(result.get("error"), str)
            self.assertTrue(result["error"])
        return result

    def create_board(self, name="Test board", **fields):
        created = self.api("POST", "/api/boards", {"name": name, **fields}, expected=201)
        self.assertIs(created.get("ok"), True)
        self.assertIsInstance(created["id"], int)
        return self.api("GET", f"/api/boards/{created['id']}")

    def create_card(self, column_id, title, **fields):
        created = self.api("POST", f"/api/columns/{column_id}/cards", {"title": title, **fields}, expected=201)
        self.assertIs(created.get("ok"), True)
        return created["id"]

    def board(self, board_id):
        return self.api("GET", f"/api/boards/{board_id}")

    def assert_card_order(self, board_id, column_id, expected_ids):
        column = next(col for col in self.board(board_id)["columns"] if col["id"] == column_id)
        self.assertEqual([card["id"] for card in column["cards"]], expected_ids)
        self.assertEqual([card["position"] for card in column["cards"]], list(range(len(expected_ids))))
        return column["cards"]

    def test_health_and_static_files(self):
        self.assertEqual(self.api("GET", "/api/health")["status"], "ok")
        for path, expected_type, expected_body in [
            ("/", "text/html", b"OpenBoard test"),
            ("/styles.css", "text/css", b"color: teal"),
            ("/app.js", "javascript", b"console.log"),
        ]:
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn(expected_type, headers.get("content-type", ""))
                self.assertIn(expected_body, body)

    def test_static_directory_traversal_is_blocked(self):
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"):
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertIn(status, (400, 403, 404))
                self.assertNotIn(b"must never be served", body)

    def test_board_crud_and_json_roundtrip(self):
        special = "L'équipe — \"idee\" \\ piano\n日本語 🚀"
        board = self.create_board(special, description=special, color="sage")
        self.assertEqual(board["name"], special)
        self.assertEqual(board["description"], special)
        self.assertEqual(board["color"], "sage")
        self.assertEqual(len(board["columns"]), 3)
        self.assertEqual([col["position"] for col in board["columns"]], [0, 1, 2])
        listing = self.api("GET", "/api/boards")["boards"]
        listed = next(item for item in listing if item["id"] == board["id"])
        self.assertEqual(listed["name"], special)
        self.assertIn("starred", listed)
        self.api("PATCH", f"/api/boards/{board['id']}", {
            "name": "Renamed", "description": "Updated", "color": "peach", "starred": True,
        })
        updated = self.board(board["id"])
        self.assertEqual(updated["name"], "Renamed")
        self.assertEqual(updated["description"], "Updated")
        self.assertEqual(updated["color"], "peach")
        self.assertIs(updated["starred"], True)
        self.api("PATCH", f"/api/boards/{board['id']}", {"name": TITLE_200})
        self.assertEqual(self.board(board["id"])["name"], TITLE_200)
        self.api("DELETE", f"/api/boards/{board['id']}")
        self.api("GET", f"/api/boards/{board['id']}", expected=404)
        self.assertNotIn(board["id"], [item["id"] for item in self.api("GET", "/api/boards")["boards"]])

    def test_column_crud_and_card_cascade(self):
        board = self.create_board()
        created = self.api("POST", f"/api/boards/{board['id']}/columns", {"title": "Review"}, expected=201)
        column_id = created["id"]
        self.assertEqual(self.board(board["id"])["columns"][-1]["position"], 3)
        card_id = self.create_card(column_id, "Delete with column")
        self.api("PATCH", f"/api/columns/{column_id}", {"title": "Ready to ship"})
        self.assertEqual(self.board(board["id"])["columns"][-1]["title"], "Ready to ship")
        self.api("PATCH", f"/api/columns/{column_id}", {"title": TITLE_200})
        self.assertEqual(self.board(board["id"])["columns"][-1]["title"], TITLE_200)
        self.api("DELETE", f"/api/columns/{column_id}")
        self.api("PATCH", f"/api/cards/{card_id}", {"title": "Gone"}, expected=404)
        remaining = self.board(board["id"])["columns"]
        self.assertEqual(len(remaining), 3)
        self.assertEqual([col["position"] for col in remaining], [0, 1, 2])
        self.api("DELETE", f"/api/columns/{board['columns'][1]['id']}")
        self.assertEqual([col["position"] for col in self.board(board["id"])["columns"]], [0, 1])

    def test_card_crud_checklist_and_escaping(self):
        board = self.create_board()
        column_id = board["columns"][0]["id"]
        text = "Fix \"quotes\" & <script>alert('x')</script> \\ newline\nCaffè ☕"
        checklist = [{"id": "item-1", "text": text, "done": False}]
        card_id = self.create_card(column_id, text, description=text, label="sviluppo",
                                   due_date="2026-10-20", assignee="Ada", cover="lavender",
                                   completed=False, checklist=checklist)
        card = self.assert_card_order(board["id"], column_id, [card_id])[0]
        self.assertEqual(card["title"], text)
        self.assertEqual(card["description"], text)
        self.assertEqual(card["column_id"], column_id)
        self.assertEqual(card["label"], "sviluppo")
        self.assertEqual(card["due_date"], "2026-10-20")
        self.assertEqual(card["assignee"], "Ada")
        self.assertEqual(card["cover"], "lavender")
        self.assertIs(card["completed"], False)
        self.assertEqual(card["checklist"], checklist)
        for leap_date in ("2028-02-29", "2000-02-29"):
            self.api("PATCH", f"/api/cards/{card_id}", {"due_date": leap_date})
            self.assertEqual(self.assert_card_order(board["id"], column_id, [card_id])[0]["due_date"], leap_date)
        changed = [{"id": "item-1", "text": text, "done": True},
                   {"id": "item-2", "text": "Review", "done": False}]
        self.api("PATCH", f"/api/cards/{card_id}", {"title": "Done", "description": "", "label": "",
                 "due_date": "", "assignee": "", "cover": "", "completed": True, "checklist": changed})
        card = self.assert_card_order(board["id"], column_id, [card_id])[0]
        self.assertEqual(card["checklist"], changed)
        self.assertIs(card["completed"], True)
        for field in ("description", "label", "due_date", "assignee", "cover"):
            self.assertEqual(card[field], "")
        self.api("PATCH", f"/api/cards/{card_id}", {"title": TITLE_300})
        self.assertEqual(self.assert_card_order(board["id"], column_id, [card_id])[0]["title"], TITLE_300)
        self.api("DELETE", f"/api/cards/{card_id}")
        self.assert_card_order(board["id"], column_id, [])

    def test_card_moves_keep_dense_order_and_board_isolation(self):
        board = self.create_board("First")
        second = self.create_board("Second")
        source, target = [col["id"] for col in board["columns"][:2]]
        a, b, c = [self.create_card(source, title) for title in ("A", "B", "C")]
        x = self.create_card(target, "X")
        self.api("PATCH", f"/api/cards/{c}", {"position": 0})
        self.assert_card_order(board["id"], source, [c, a, b])
        self.api("PATCH", f"/api/cards/{c}", {"position": 2})
        self.assert_card_order(board["id"], source, [a, b, c])
        self.api("PATCH", f"/api/cards/{b}", {"column_id": target, "position": 0})
        self.assert_card_order(board["id"], source, [a, c])
        self.assert_card_order(board["id"], target, [b, x])
        self.api("PATCH", f"/api/cards/{b}", {"column_id": second["columns"][0]["id"], "position": 0}, expected=400)
        self.assert_card_order(board["id"], target, [b, x])
        self.assertTrue(all(not col["cards"] for col in self.board(second["id"])["columns"]))
        self.api("DELETE", f"/api/cards/{a}")
        self.assert_card_order(board["id"], source, [c])
        self.api("DELETE", f"/api/boards/{board['id']}")
        self.api("PATCH", f"/api/cards/{b}", {"title": "Deleted"}, expected=404)
        self.assertEqual(self.board(second["id"])["name"], "Second")

    def test_invalid_input_and_missing_resources(self):
        board = self.create_board()
        column_id = board["columns"][0]["id"]
        card_id = self.create_card(column_id, "Keep unchanged")
        invalid_requests = [
            ("POST", "/api/boards", {"name": ""}),
            ("POST", "/api/boards", {"name": "   "}),
            ("POST", "/api/boards", {"name": 42}),
            ("PATCH", f"/api/boards/{board['id']}", {"name": TITLE_200 + "è"}),
            ("PATCH", f"/api/boards/{board['id']}", {"starred": "yes"}),
            ("POST", f"/api/boards/{board['id']}/columns", {"title": ""}),
            ("PATCH", f"/api/columns/{column_id}", {"title": []}),
            ("PATCH", f"/api/columns/{column_id}", {"title": TITLE_200 + "🚀"}),
            ("POST", f"/api/columns/{column_id}/cards", {"title": ""}),
            ("PATCH", f"/api/cards/{card_id}", {"title": "  "}),
            ("PATCH", f"/api/cards/{card_id}", {"title": TITLE_300 + "è"}),
            ("PATCH", f"/api/cards/{card_id}", {"description": []}),
            ("PATCH", f"/api/cards/{card_id}", {"completed": "false"}),
            ("PATCH", f"/api/cards/{card_id}", {"label": "not-a-label"}),
            ("PATCH", f"/api/cards/{card_id}", {"cover": "not-a-cover"}),
            ("PATCH", f"/api/cards/{card_id}", {"due_date": "tomorrow"}),
            *[("PATCH", f"/api/cards/{card_id}", {"due_date": date})
              for date in ("2026-02-29", "2100-02-29", "2026-04-31", "2026-13-01")],
            ("PATCH", f"/api/cards/{card_id}", {"checklist": "invalid"}),
            ("PATCH", f"/api/cards/{card_id}", {"checklist": [{"id": "x", "text": "Check", "done": "yes"}]}),
            ("PATCH", f"/api/cards/{card_id}", {"position": -1}),
            ("PATCH", f"/api/cards/{card_id}", {"position": 999}),
            ("PATCH", f"/api/cards/{card_id}", {"position": 0.5}),
            ("PATCH", f"/api/cards/{card_id}", {"position": 2**100}),
            ("PATCH", f"/api/cards/{card_id}", {"column_id": "wrong"}),
            ("PATCH", f"/api/cards/{card_id}", {"column_id": 2**100}),
        ]
        for method, path, payload in invalid_requests:
            with self.subTest(method=method, path=path, payload=payload):
                self.api(method, path, payload, expected=400)
        self.assertEqual(self.assert_card_order(board["id"], column_id, [card_id])[0]["title"], "Keep unchanged")
        for method, path, payload in [
            ("GET", "/api/boards/99999999", None),
            ("PATCH", "/api/boards/99999999", {"name": "Missing"}),
            ("POST", "/api/boards/99999999/columns", {"title": "Missing"}),
            ("POST", "/api/columns/99999999/cards", {"title": "Missing"}),
            ("PATCH", "/api/cards/99999999", {"title": "Missing"}),
            ("DELETE", "/api/cards/99999999", None),
        ]:
            with self.subTest(method=method, path=path):
                self.api(method, path, payload, expected=404)

    def test_malformed_json_body_lengths_and_origin(self):
        for body in (b"{", b'{"name":"unfinished"', b'{"name":"x"} trailing',
                     b'{"name":"first","name":"second"}', b"[]", b""):
            with self.subTest(body=body):
                status, _, response = self.request("POST", "/api/boards", body, {"Content-Type": "application/json"})
                self.assertEqual(status, 400, response)
                self.assertIsInstance(json.loads(response)["error"], str)
        for length in ("-1", "invalid"):
            with self.subTest(content_length=length):
                status, _, response = self.request("POST", "/api/boards", b"", {
                    "Content-Type": "application/json", "Content-Length": length,
                })
                self.assertEqual(status, 400, response)
        status, _, response = self.request("POST", "/api/boards", b"", {
            "Content-Type": "application/json", "Content-Length": "268435456",
        })
        self.assertEqual(status, 413, response)
        for framing in ("Content-Length: 0\r\nContent-Length: 0",
                        "Content-Length: 0\r\nTransfer-Encoding: chunked"):
            with self.subTest(framing=framing):
                raw = (f"POST /api/boards HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                       f"{framing}\r\nConnection: close\r\n\r\n").encode("ascii")
                with socket.create_connection(("127.0.0.1", self.port), timeout=3) as connection:
                    connection.sendall(raw)
                    response = http.client.HTTPResponse(connection)
                    try:
                        response.begin()
                        self.assertEqual(response.status, 400, response.read())
                    finally:
                        response.close()
        self.api("POST", "/api/boards", {"name": "Forbidden"}, expected=403,
                 headers={"Origin": "https://evil.example"})
        self.assertNotIn("Forbidden", [board["name"] for board in self.api("GET", "/api/boards")["boards"]])

    def test_persistence_and_deleted_boards_stay_deleted(self):
        board = self.create_board("Persistent", description="Across restarts", color="blue")
        column_id = board["columns"][0]["id"]
        self.create_card(column_id, "Remember me", completed=True,
                         checklist=[{"id": "one", "text": "Saved", "done": True}])
        self.api("PATCH", f"/api/boards/{board['id']}", {"starred": True})
        self.api("PATCH", f"/api/columns/{column_id}", {"title": "Persisted list"})
        before = self.board(board["id"])
        self.stop_server()
        self.start_server()
        self.assertEqual(self.board(board["id"]), before)
        for item in self.api("GET", "/api/boards")["boards"]:
            self.api("DELETE", f"/api/boards/{item['id']}")
        self.assertEqual(self.api("GET", "/api/boards")["boards"], [])
        self.stop_server()
        self.start_server()
        self.assertEqual(self.api("GET", "/api/boards")["boards"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
