#!/usr/bin/env python3
"""Account/session and authorization integration tests using disposable databases."""
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("OPENBOARD_BINARY", ROOT / "build" / "openboard"))
PASSWORD = "correct-password-123"


class OpenBoardAuth(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openboard-auth-")
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "test.db"
        self.log = (Path(self.temp.name) / "server.log").open("w+b")
        self.addCleanup(self.log.close)
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            self.port = reserve.getsockname()[1]
        self.process = subprocess.Popen(
            [str(BINARY), "--port", str(self.port), "--db", str(self.db), "--web-root", str(ROOT / "web"), "--auth", "--quiet"],
            cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT,
        )
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail("Server startup failed: " + self.read_log())
            try:
                if self.request("GET", "/api/health")[0] == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.025)
        else:
            self.fail("Server did not start: " + self.read_log())
        self.sessions = {}
        before, _ = self.api("GET", "/api/auth/session", actor=None)
        self.assertEqual(before, {"enabled": True, "setup_required": True, "user": None, "csrf": ""})
        result, headers = self.api("POST", "/api/auth/setup", {
            "name": "Amministratore", "username": "ADMin", "password": PASSWORD,
        }, actor=None, expected=201)
        self.sessions["admin"] = self.session(result, headers)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def read_log(self):
        self.log.flush()
        return (Path(self.temp.name) / "server.log").read_text(errors="replace")

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def api(self, method, path, payload=None, *, actor="admin", expected=200, headers=None):
        request_headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        if actor is not None:
            request_headers.update({"Cookie": self.sessions[actor]["cookie"], "X-CSRF-Token": self.sessions[actor]["csrf"]})
        request_headers.update(headers or {})
        status, response_headers, body = self.request(method, path,
            None if payload is None else json.dumps(payload, ensure_ascii=False).encode(), request_headers)
        self.assertEqual(status, expected, f"{method} {path}: {body!r}")
        self.assertIn("application/json", response_headers.get("content-type", ""))
        result = json.loads(body)
        if expected >= 400:
            self.assertTrue(result.get("error"))
        return result, response_headers

    def session(self, result, headers):
        self.assertEqual(len(result["csrf"]), 64)
        self.assertFalse(result["setup_required"])
        cookie = headers["set-cookie"]
        for attribute in ("HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=28800"):
            self.assertIn(attribute, cookie)
        return {"cookie": cookie.split(";", 1)[0], "csrf": result["csrf"], "id": result["user"]["id"]}

    def add_user(self, username, role="member"):
        result, _ = self.api("POST", "/api/users", {
            "name": username.title(), "username": username, "password": PASSWORD, "role": role,
        }, expected=201)
        return result["id"]

    def login(self, username, key=None):
        result, headers = self.api("POST", "/api/auth/login", {
            "username": username, "password": PASSWORD,
        }, actor=None)
        self.sessions[key or username] = self.session(result, headers)
        return result

    def sql(self, query, parameters=()):
        with sqlite3.connect(self.db) as connection:
            return connection.execute(query, parameters).fetchall()

    def test_setup_session_and_hashed_storage(self):
        self.api("POST", "/api/auth/setup", {}, actor=None, expected=409)
        session, headers = self.api("GET", "/api/auth/session")
        self.assertEqual(session["user"]["username"], "admin")
        self.assertEqual(session["csrf"], self.sessions["admin"]["csrf"])
        self.assertEqual(headers["cache-control"], "no-store")
        password_hash, salt = self.sql("SELECT password_hash,salt FROM users")[0]
        self.assertRegex(password_hash, r"^[0-9a-f]{64}$")
        self.assertRegex(salt, r"^[0-9a-f]{32}$")
        token_hash, = self.sql("SELECT token_hash FROM sessions")[0]
        self.assertNotEqual(token_hash, self.sessions["admin"]["cookie"].split("=", 1)[1])
        self.assertNotIn(PASSWORD, password_hash + salt + token_hash)
        self.assertEqual(len(self.sql("SELECT * FROM board_members WHERE user_id=1 AND role='admin'")), 3)

    def test_anonymous_and_csrf_and_cross_origin_protection(self):
        self.api("GET", "/api/boards", actor=None, expected=401)
        self.api("POST", "/api/boards", {"name": "Missing CSRF"}, headers={"X-CSRF-Token": ""}, expected=403)
        self.api("POST", "/api/users", {"name": "Blocked"}, headers={"X-CSRF-Token": "0" * 64}, expected=403)
        self.api("POST", "/api/auth/login", {"username": "admin", "password": PASSWORD},
                 actor=None, headers={"Origin": "https://attacker.example"}, expected=403)
        self.api("POST", "/api/auth/setup", {}, actor=None,
                 headers={"Sec-Fetch-Site": "cross-site"}, expected=403)
        session, _ = self.api("GET", "/api/auth/session", actor=None)
        self.assertIsNone(session["user"])

    def test_username_casefold_and_password_bounds(self):
        user_id = self.add_user("Alice")
        login = self.login("ALICE", "alice")
        self.assertEqual(login["user"]["id"], user_id)
        self.assertEqual(login["user"]["username"], "alice")
        self.api("POST", "/api/users", {"name": "Duplicate", "username": "aLiCe", "password": PASSWORD}, expected=409)
        for password in ("a" * 11, "é" * 129, "a" * 257):
            with self.subTest(password_bytes=len(password.encode())):
                self.api("POST", "/api/users", {"name": "Invalid", "username": "invalid", "password": password}, expected=400)
        self.api("POST", "/api/users", {"name": "Unicode", "username": "unicode", "password": "é" * 128}, expected=201)
        self.api("POST", "/api/users", {"name": "Invalid", "username": "invalid name", "password": PASSWORD}, expected=400)

    def test_users_admin_only_and_last_admin_guard(self):
        member_id = self.add_user("member")
        self.login("member")
        self.api("GET", "/api/users", actor="member", expected=403)
        self.api("POST", "/api/users", {"name": "Denied"}, actor="member", expected=403)
        self.api("PATCH", "/api/users/1", {"role": "member"}, expected=409)
        self.api("PATCH", "/api/users/1", {"active": False}, expected=409)
        self.api("PATCH", f"/api/users/{member_id}", {"role": "admin", "name": "Second admin"})
        self.api("PATCH", "/api/users/1", {"role": "member"})
        users, _ = self.api("GET", "/api/users", actor="member")
        self.assertTrue(any(u["id"] == member_id and u["role"] == "admin" for u in users["users"]))
        self.api("PATCH", f"/api/users/{member_id}", {"active": False}, actor="member", expected=409)

    def test_membership_read_isolation_and_board_creation_owner(self):
        member_id = self.add_user("member")
        self.login("member")
        boards, _ = self.api("GET", "/api/boards", actor="member")
        self.assertEqual(boards["boards"], [])
        for path in ("/api/boards/1", "/api/boards/1/export", "/api/boards/1/activity", "/api/boards/1/stats", "/api/boards/1/members"):
            with self.subTest(path=path):
                self.api("GET", path, actor="member", expected=404)
        self.api("POST", "/api/boards/1/members", {"user_id": member_id, "role": "member"})
        board, _ = self.api("GET", "/api/boards/1", actor="member")
        self.assertEqual(board["id"], 1)
        self.api("PATCH", "/api/boards/1", {"name": "Shared"}, actor="member")
        self.api("POST", "/api/boards/1/members", {"user_id": 1, "role": "observer"}, actor="member", expected=403)
        own, _ = self.api("POST", "/api/boards", {"name": "Personal board"}, actor="member", expected=201)
        self.assertEqual(self.sql("SELECT role FROM board_members WHERE board_id=? AND user_id=?", (own["id"], member_id)), [("admin",)])
        self.api("POST", f"/api/boards/{own['id']}/members", {"user_id": 1, "role": "member"}, actor="member")
        self.api("DELETE", "/api/boards/1/members/" + str(member_id))
        self.api("GET", "/api/boards/1", actor="member", expected=404)

    def test_observers_read_only_but_personal_stars_are_allowed(self):
        observer_id = self.add_user("observer", "observer")
        self.login("observer")
        self.api("POST", "/api/boards/1/members", {"user_id": observer_id, "role": "admin"})
        board, _ = self.api("GET", "/api/boards/1", actor="observer")
        self.api("POST", "/api/boards", {"name": "Forbidden"}, actor="observer", expected=403)
        self.api("PATCH", "/api/boards/1", {"name": "Forbidden"}, actor="observer", expected=403)
        self.api("POST", f"/api/columns/{board['columns'][0]['id']}/cards", {"title": "Forbidden"}, actor="observer", expected=403)
        self.api("POST", "/api/boards/1/members", {"user_id": 1, "role": "member"}, actor="observer", expected=403)
        self.api("PATCH", "/api/boards/2/star", {"starred": True}, actor="observer", expected=404)
        self.api("PATCH", "/api/boards/1/star", {"starred": True}, actor="observer")
        observer_board, _ = self.api("GET", "/api/boards/1", actor="observer")
        admin_board, _ = self.api("GET", "/api/boards/1")
        self.assertTrue(observer_board["starred"])
        self.assertFalse(admin_board["starred"])
        self.api("PATCH", "/api/boards/1/star", {"starred": False}, actor="observer")
        self.assertEqual(self.sql("SELECT * FROM user_stars WHERE user_id=?", (observer_id,)), [])

    def test_board_observer_membership_blocks_writes(self):
        member_id = self.add_user("member")
        self.login("member")
        self.api("POST", "/api/boards/1/members", {"user_id": member_id, "role": "observer"})
        self.api("GET", "/api/boards/1", actor="member")
        self.api("PATCH", "/api/boards/1", {"name": "Forbidden"}, actor="member", expected=404)
        self.api("POST", "/api/boards/1/columns", {"title": "Forbidden"}, actor="member", expected=404)
        self.api("POST", "/api/boards/1/members", {"user_id": 1, "role": "member"}, actor="member", expected=403)

    def test_password_change_revokes_other_sessions_and_logout(self):
        self.add_user("member")
        self.login("member")
        self.login("member", "other")
        self.api("POST", "/api/auth/password", {"current_password": "wrong", "password": "new-password-123"}, actor="member", expected=401)
        self.api("POST", "/api/auth/password", {"current_password": PASSWORD, "password": "new-password-123"}, actor="member")
        other, _ = self.api("GET", "/api/auth/session", actor="other")
        self.assertIsNone(other["user"])
        self.api("GET", "/api/boards", actor="other", expected=401)
        self.api("POST", "/api/auth/login", {"username": "member", "password": PASSWORD}, actor=None, expected=401)
        changed, _ = self.api("POST", "/api/auth/login", {"username": "member", "password": "new-password-123"}, actor=None)
        self.assertEqual(changed["user"]["username"], "member")
        _, headers = self.api("POST", "/api/auth/logout", {}, actor="member")
        self.assertIn("Max-Age=0", headers["set-cookie"])
        self.api("GET", "/api/boards", actor="member", expected=401)

    def test_deactivation_revokes_sessions_and_reactivation_requires_login(self):
        member_id = self.add_user("member")
        self.login("member")
        self.api("PATCH", f"/api/users/{member_id}", {"active": False})
        self.api("GET", "/api/boards", actor="member", expected=401)
        self.api("POST", "/api/auth/login", {"username": "member", "password": PASSWORD}, actor=None, expected=401)
        self.api("PATCH", f"/api/users/{member_id}", {"active": True})
        self.api("GET", "/api/boards", actor="member", expected=401)
        self.login("member")
        self.api("GET", "/api/boards", actor="member")

    def test_session_idle_absolute_expiry_and_duplicate_cookie(self):
        cookie = self.sessions["admin"]["cookie"]
        self.api("GET", "/api/boards", headers={"Cookie": cookie + "; " + cookie}, expected=401)
        self.sql("UPDATE sessions SET last_seen=last_seen-1801")
        self.api("GET", "/api/boards", expected=401)
        self.login("admin")
        self.sql("UPDATE sessions SET expires_at=0")
        self.api("GET", "/api/boards", expected=401)

    def test_login_rate_limit_and_generic_credentials_error(self):
        wrong, _ = self.api("POST", "/api/auth/login", {"username": "admin", "password": "wrong"}, actor=None, expected=401)
        missing, _ = self.api("POST", "/api/auth/login", {"username": "missing", "password": "wrong"}, actor=None, expected=401)
        self.assertEqual(wrong, missing)
        for _ in range(9):
            self.api("POST", "/api/auth/login", {"username": "missing", "password": "wrong"}, actor=None, expected=401)
        _, headers = self.api("POST", "/api/auth/login", {"username": "missing", "password": "wrong"}, actor=None, expected=429)
        self.assertEqual(headers["retry-after"], "300")
        self.assertEqual(headers["cache-control"], "no-store")

    def test_members_and_stars_on_deleted_boards_are_hidden(self):
        self.api("DELETE", "/api/boards/1")
        self.api("GET", "/api/boards/1/members", expected=404)
        self.api("POST", "/api/boards/1/members", {"user_id": 1, "role": "admin"}, expected=404)
        self.api("PATCH", "/api/boards/1/star", {"starred": True}, expected=404)

    def test_membership_changes_have_activity_and_stars_remain_personal(self):
        member_id = self.add_user("member")
        before, _ = self.api("GET", "/api/boards/1")
        self.api("POST", "/api/boards/1/members", {"user_id": member_id, "role": "member"})
        after, _ = self.api("GET", "/api/boards/1")
        self.assertGreater(after["version"], before["version"])
        events, _ = self.api("GET", "/api/boards/1/activity")
        self.assertEqual(events["events"][0]["action"], "membership_updated")
        self.assertEqual(events["events"][0]["actor_id"], self.sessions["admin"]["id"])
        self.assertEqual(events["events"][0]["entity_id"], member_id)
        self.api("PATCH", "/api/boards/1/star", {"starred": True})
        starred, _ = self.api("GET", "/api/boards/1")
        self.assertEqual(starred["version"], after["version"])
        self.api("DELETE", f"/api/boards/1/members/{member_id}")
        events, _ = self.api("GET", "/api/boards/1/activity")
        self.assertEqual(events["events"][0]["action"], "membership_removed")

    def test_https_public_url_sets_secure_session_cookie(self):
        self.stop()
        self.process = subprocess.Popen(
            [str(BINARY), "--port", str(self.port), "--db", str(self.db), "--web-root", str(ROOT / "web"),
             "--auth", "--quiet", "--public-url", "https://openboard.example"],
            cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail("HTTPS origin startup failed: " + self.read_log())
            try:
                if self.request("GET", "/api/health")[0] == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.025)
        result, headers = self.api("POST", "/api/auth/login", {"username": "admin", "password": PASSWORD},
            actor=None, headers={"Origin": "https://openboard.example"})
        self.assertEqual(result["user"]["username"], "admin")
        self.assertIn("; Secure", headers["set-cookie"])

    def test_sql_failure_during_login_releases_secrets_and_server_recovers(self):
        self.sql("ALTER TABLE users RENAME TO unavailable_users")
        try:
            self.api("POST", "/api/auth/login", {"username": "admin", "password": PASSWORD},
                actor=None, expected=503)
        finally:
            self.sql("ALTER TABLE unavailable_users RENAME TO users")
        session, _ = self.api("GET", "/api/auth/session")
        self.assertEqual(session["user"]["username"], "admin")
        self.assertNotIn(PASSWORD, self.read_log())


if __name__ == "__main__":
    unittest.main()
