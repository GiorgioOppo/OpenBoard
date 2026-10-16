#!/usr/bin/env python3
"""Collaboration permissions, bounded files and private account integration checks."""
import base64
import test_auth as auth_helpers
import unittest


class OpenBoardCollaboration(unittest.TestCase):
    setUp = auth_helpers.OpenBoardAuth.setUp
    stop = auth_helpers.OpenBoardAuth.stop
    read_log = auth_helpers.OpenBoardAuth.read_log
    request = auth_helpers.OpenBoardAuth.request
    api = auth_helpers.OpenBoardAuth.api
    session = auth_helpers.OpenBoardAuth.session
    add_user = auth_helpers.OpenBoardAuth.add_user
    login = auth_helpers.OpenBoardAuth.login
    sql = auth_helpers.OpenBoardAuth.sql

    def member(self, name="alice", role="member", board=1):
        user = self.add_user(name, role)
        self.api("POST", f"/api/boards/{board}/members", {"user_id": user, "role": role})
        self.login(name)
        return user

    def upload(self, data=b"hello\x00world", name="Caffè ☕.txt", mime="text/plain", card=1, actor="admin", expected=201):
        result, _ = self.api("POST", f"/api/cards/{card}/attachments", {
            "name": name, "mime": mime, "data_base64": base64.b64encode(data).decode(),
        }, actor=actor, expected=expected)
        return result

    def test_watch_notifications_actor_suppression_dedup_and_pagination(self):
        self.member()
        self.api("PATCH", "/api/boards/1/watch", {"watching": True}, actor="alice")
        self.api("POST", "/api/cards/1/watch", {"watching": True}, actor="alice")
        watches, _ = self.api("GET", "/api/me/watches", actor="alice")
        self.assertEqual([b["id"] for b in watches["boards"]], [1])
        self.assertEqual([k["id"] for k in watches["cards"]], [1])
        for title in ("First notification", "Second notification", "Third notification"):
            self.api("PATCH", "/api/cards/1", {"title": title})
        first, _ = self.api("GET", "/api/notifications?limit=2", actor="alice")
        self.assertEqual(len(first["items"]), 2)
        self.assertEqual(first["unread_count"], 3)
        self.assertEqual(len({n["activity_id"] for n in first["items"]}), 2)
        self.assertIsInstance(first["next_cursor"], int)
        second, _ = self.api("GET", f"/api/notifications?limit=2&before={first['next_cursor']}", actor="alice")
        self.assertEqual(len(second["items"]), 1)
        self.assertIsNone(second["next_cursor"])
        self.assertLess(second["items"][0]["id"], first["items"][-1]["id"])
        self.api("PATCH", "/api/cards/1", {"title": "Alice's own mutation"}, actor="alice")
        count, _ = self.api("GET", "/api/notifications/unread-count", actor="alice")
        self.assertEqual(count["unread_count"], 3)
        notification = first["items"][0]["id"]
        self.api("PATCH", f"/api/notifications/{notification}", {"read": True}, actor="alice")
        count, _ = self.api("GET", "/api/notifications/unread-count", actor="alice")
        self.assertEqual(count["unread_count"], 2)
        self.api("PATCH", f"/api/notifications/{notification}", {"read": False}, actor="alice")
        self.api("POST", "/api/notifications/read-all", {}, actor="alice")
        count, _ = self.api("GET", "/api/notifications/unread-count", actor="alice")
        self.assertEqual(count["unread_count"], 0)
        self.api("PATCH", f"/api/notifications/{notification}", {"read": True}, expected=404)
        for query in ("limit=0", "limit=101", "before=nope", "before=-1", "limit=1&limit=2"):
            self.api("GET", "/api/notifications?" + query, actor="alice", expected=400)

    def test_membership_revocation_hides_previous_notifications_and_watches(self):
        alice = self.member()
        self.api("PATCH", "/api/boards/1/watch", {"watching": True}, actor="alice")
        self.api("PATCH", "/api/cards/1", {"title": "Private item"})
        first, _ = self.api("GET", "/api/notifications", actor="alice")
        notification = first["items"][0]["id"]
        self.api("DELETE", f"/api/boards/1/members/{alice}")
        for path in ("/api/notifications", "/api/notifications/unread-count"):
            result, _ = self.api("GET", path, actor="alice")
            self.assertEqual(result["unread_count"], 0)
        result, _ = self.api("GET", "/api/me/watches", actor="alice")
        self.assertEqual(result, {"boards": [], "cards": []})
        self.api("PATCH", f"/api/notifications/{notification}", {"read": True}, actor="alice", expected=404)
        self.api("PATCH", "/api/cards/1/watch", {"watching": True}, actor="alice", expected=404)
        self.api("PATCH", "/api/cards/1", {"title": "After revocation"})
        self.assertEqual(len(self.sql("SELECT * FROM notifications WHERE user_id=?", (alice,))), 1)

    def test_attachment_binary_round_trip_soft_delete_restore_and_permissions(self):
        self.member()
        outsider = self.add_user("outside")
        self.login("outside")
        data = bytes(range(256)) * 4096
        result = self.upload(data)
        attachment = result["id"]
        files, _ = self.api("GET", "/api/cards/1/attachments", actor="alice")
        metadata = files["attachments"][0]
        self.assertEqual(metadata["size"], 1048576)
        self.assertEqual(metadata["name"], "Caffè ☕.txt")
        downloaded, headers = self.api("GET", f"/api/attachments/{attachment}", actor="alice")
        self.assertEqual(base64.b64decode(downloaded["data_base64"]), data)
        self.assertIn("attachment", headers["content-disposition"])
        self.assertEqual(headers["cache-control"], "no-store")
        self.api("GET", f"/api/attachments/{attachment}", actor="outside", expected=404)
        self.api("DELETE", f"/api/attachments/{attachment}", actor="outside", expected=404)
        self.api("DELETE", f"/api/attachments/{attachment}", actor="alice")
        self.api("GET", f"/api/attachments/{attachment}", expected=404)
        files, _ = self.api("GET", "/api/cards/1/attachments")
        self.assertTrue(files["attachments"][0]["deleted_at"])
        self.api("POST", f"/api/attachments/{attachment}/restore", {})
        downloaded, _ = self.api("GET", f"/api/attachments/{attachment}")
        self.assertEqual(base64.b64decode(downloaded["data_base64"]), data)
        self.assertTrue(outsider)

    def test_attachment_strict_base64_names_mime_size_and_both_quotas(self):
        for value in ("Zg=", "Z g==", "Zh==", "Zm9=", "====", "Zg==\n", "AA-A", "AA_A"):
            self.api("POST", "/api/cards/1/attachments", {"name": "safe.txt", "mime": "text/plain", "data_base64": value}, expected=400)
        for name in ("../evil", "a\\b", ".", "..", "bad\nname", "bad\x00name", "x" * 181):
            self.upload(name=name, expected=400)
        for mime in ("text/html; charset=utf-8", "text/", "/plain", "a/b/c", "text/☕"):
            self.upload(mime=mime, expected=400)
        self.upload(b"a" * 1048577, expected=400)
        one = self.upload(b"a" * 1048576)["id"]
        for _ in range(4):
            self.upload(b"a" * 1048576)
        self.upload(b"b", expected=409)
        self.api("DELETE", f"/api/attachments/{one}")
        self.upload(b"a" * 1048576)
        self.api("POST", f"/api/attachments/{one}/restore", {}, expected=409)
        for _ in range(10):
            self.upload(b"", card=2)
        self.upload(b"", card=2, expected=409)

    def test_observer_personal_controls_but_no_comment_or_attachment_writes(self):
        self.member("viewer", "observer")
        self.api("PATCH", "/api/cards/1/watch", {"watching": True}, actor="viewer")
        self.api("PATCH", "/api/me/profile", {"name": "Nuovo nome ☕", "role": "admin", "active": True}, actor="viewer")
        profile, _ = self.api("GET", "/api/me/profile", actor="viewer")
        self.assertEqual(profile["name"], "Nuovo nome ☕")
        self.assertEqual(profile["role"], "observer")
        self.api("POST", "/api/notifications/read-all", {}, actor="viewer")
        self.api("POST", "/api/me/sessions/revoke-others", {}, actor="viewer")
        file = self.upload()["id"]
        self.api("GET", f"/api/attachments/{file}", actor="viewer")
        self.upload(actor="viewer", expected=404)
        self.api("DELETE", f"/api/attachments/{file}", actor="viewer", expected=404)
        comment, _ = self.api("POST", "/api/cards/1/comments", {"body": "Original"}, expected=201)
        self.api("PATCH", f"/api/comments/{comment['id']}", {"body": "Nope"}, actor="viewer", expected=404)

    def test_comment_author_edit_version_conflict_and_activity_pagination(self):
        self.member()
        comment, _ = self.api("POST", "/api/cards/1/comments", {"body": "Original"}, actor="alice", expected=201)
        comment_id = comment["id"]
        self.member("bob")
        self.api("PATCH", f"/api/comments/{comment_id}", {"body": "Other author"}, actor="bob", expected=403)
        updated, _ = self.api("PATCH", f"/api/comments/{comment_id}", {"body": "Changed ☕"}, actor="alice", headers={"If-Match": '"1"'})
        self.assertEqual(updated["version"], 2)
        self.api("PATCH", f"/api/comments/{comment_id}", {"body": "Lost update"}, actor="alice", headers={"If-Match": "1"}, expected=412)
        comments, _ = self.api("GET", "/api/cards/1/comments")
        self.assertEqual(comments["comments"][0]["body"], "Changed ☕")
        self.assertTrue(comments["comments"][0]["edited_at"])
        self.assertEqual(comments["comments"][0]["version"], 2)
        self.api("PATCH", f"/api/comments/{comment_id}", {"body": "   "}, expected=400)
        self.api("PATCH", f"/api/comments/{comment_id}", {"body": "Admin can edit"})
        first, _ = self.api("GET", "/api/boards/1/activity-page?limit=2", actor="alice")
        self.assertEqual(len(first["items"]), 2)
        self.assertIsInstance(first["next_cursor"], int)
        next_page, _ = self.api("GET", f"/api/boards/1/activity-page?limit=2&before={first['next_cursor']}", actor="alice")
        self.assertTrue(next_page["items"])
        self.assertTrue(set(e["id"] for e in first["items"]).isdisjoint(e["id"] for e in next_page["items"]))
        self.api("GET", "/api/boards/2/activity-page", actor="alice", expected=404)

    def test_activity_and_notification_storage_failure_roll_back_the_whole_write(self):
        self.member()
        self.api("PATCH", "/api/boards/1/watch", {"watching": True}, actor="alice")
        old, _ = self.api("GET", "/api/cards/1")
        self.sql("CREATE TRIGGER reject_notifications BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'test notification storage failure'); END")
        self.api("PATCH", "/api/cards/1", {"title": "Must roll back"}, expected=503)
        current, _ = self.api("GET", "/api/cards/1")
        self.assertEqual(current["title"], old["title"])
        self.assertEqual(self.sql("SELECT count(*) FROM notifications")[0][0], 0)
        self.sql("DROP TRIGGER reject_notifications")
        self.sql("CREATE TRIGGER reject_attachment_activity BEFORE INSERT ON activity WHEN NEW.action='attachment_added' BEGIN SELECT RAISE(ABORT,'test activity storage failure'); END")
        self.upload(expected=503)
        self.assertEqual(self.sql("SELECT count(*) FROM attachments")[0][0], 0)
        self.sql("DROP TRIGGER reject_attachment_activity")
        self.upload()
        self.sql("ALTER TABLE attachments RENAME TO inaccessible_attachments")
        self.upload(expected=503)
        self.sql("ALTER TABLE inaccessible_attachments RENAME TO attachments")
        self.api("GET", "/api/health")

    def test_local_attachments_work_while_account_tools_require_auth_mode(self):
        self.stop()
        self.process = auth_helpers.subprocess.Popen(
            [str(auth_helpers.BINARY), "--port", str(self.port), "--db", str(self.db), "--no-auth", "--quiet"],
            cwd=auth_helpers.ROOT, stdout=self.log, stderr=auth_helpers.subprocess.STDOUT,
        )
        deadline = auth_helpers.time.monotonic() + 5
        while auth_helpers.time.monotonic() < deadline:
            try:
                if self.request("GET", "/api/health")[0] == 200:
                    break
            except (OSError, auth_helpers.http.client.HTTPException):
                pass
            auth_helpers.time.sleep(0.025)
        else:
            self.fail("Local server restart failed: " + self.read_log())
        for path in ("/api/me/profile", "/api/me/sessions", "/api/me/watches", "/api/notifications"):
            self.api("GET", path, actor=None, expected=403)
        self.api("PATCH", "/api/cards/1/watch", {"watching": True}, actor=None, expected=403)
        file = self.upload(actor=None)["id"]
        downloaded, _ = self.api("GET", f"/api/attachments/{file}", actor=None)
        self.assertEqual(base64.b64decode(downloaded["data_base64"]), b"hello\x00world")

    def test_private_session_ids_and_owned_revocation(self):
        self.login("admin", "second")
        self.login("admin", "third")
        result, _ = self.api("GET", "/api/me/sessions")
        self.assertEqual(len(result["sessions"]), 3)
        self.assertEqual(sum(s["current"] for s in result["sessions"]), 1)
        current = next(s for s in result["sessions"] if s["current"])
        others = [s for s in result["sessions"] if not s["current"]]
        for session in result["sessions"]:
            self.assertRegex(session["id"], r"^[0-9a-f]{32}$")
            self.assertNotIn("token_hash", session)
            self.assertNotIn("csrf", session)
        self.api("DELETE", f"/api/me/sessions/{current['id']}", expected=409)
        self.member()
        self.api("DELETE", f"/api/me/sessions/{others[0]['id']}", actor="alice", expected=404)
        self.api("DELETE", f"/api/me/sessions/{others[0]['id']}")
        self.api("POST", "/api/me/sessions/revoke-others", {})
        self.api("GET", "/api/boards", actor="second", expected=401)
        self.api("GET", "/api/boards", actor="third", expected=401)
        result, _ = self.api("GET", "/api/me/sessions")
        self.assertEqual(len(result["sessions"]), 1)
        self.assertTrue(result["sessions"][0]["current"])


if __name__ == "__main__":
    unittest.main()
