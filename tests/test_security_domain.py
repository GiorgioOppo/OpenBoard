"""Authorization is checked under the write lock and before cached POST replies.

All accounts, SQLite writes and HTTP traffic belong to disposable loopback test
fixtures. No deployment, external database or existing account is touched.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import sqlite3
import time
import unittest

import test_auth as auth_helpers


class OpenBoardDomainSecurity(unittest.TestCase):
    setUp = auth_helpers.OpenBoardAuth.setUp
    stop = auth_helpers.OpenBoardAuth.stop
    read_log = auth_helpers.OpenBoardAuth.read_log
    request = auth_helpers.OpenBoardAuth.request
    api = auth_helpers.OpenBoardAuth.api
    session = auth_helpers.OpenBoardAuth.session
    add_user = auth_helpers.OpenBoardAuth.add_user
    login = auth_helpers.OpenBoardAuth.login
    sql = auth_helpers.OpenBoardAuth.sql

    def member(self, username, role="member", global_role="member"):
        uid = self.add_user(username, global_role)
        self.api("POST", "/api/boards/1/members", {"user_id": uid, "role": role})
        self.login(username)
        return uid

    def cached(self, path, payload, actor, key, expected=201):
        return self.api("POST", path, payload, actor=actor, expected=expected,
                        headers={"Idempotency-Key": key})

    def test_waiting_write_rechecks_deactivated_session_inside_transaction(self):
        uid = self.add_user("waitingadmin", "admin")
        self.login("waitingadmin")
        before = self.sql("SELECT count(*) FROM boards")[0][0]
        actor = self.sessions["waitingadmin"]
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}",
                   "Cookie": actor["cookie"], "X-CSRF-Token": actor["csrf"]}
        with closing(sqlite3.connect(self.db, timeout=5)) as lock, ThreadPoolExecutor(max_workers=1) as pool:
            lock.execute("BEGIN IMMEDIATE")
            pending = pool.submit(self.request, "POST", "/api/boards",
                                  json.dumps({"name": "Must not be created"}).encode(), headers)
            time.sleep(0.2)
            self.assertFalse(pending.done())
            lock.execute("UPDATE users SET active=0 WHERE id=?", (uid,))
            lock.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            lock.commit()
            status, response_headers, body = pending.result(timeout=5)
        self.assertEqual(status, 401, body)
        self.assertNotIn("idempotency-replayed", response_headers)
        self.assertEqual(self.sql("SELECT count(*) FROM boards")[0][0], before)

    def test_sprint_replay_preserves_success_mismatch_and_denies_current_acl_revocation(self):
        uid = self.member("manager", "admin")
        path, payload = "/api/boards/1/sprints", {"name": "Protected sprint", "goal": "Private scope"}
        initial, _ = self.cached(path, payload, "manager", "sprint-security")
        repeated, headers = self.cached(path, payload, "manager", "sprint-security")
        self.assertEqual(repeated, initial)
        self.assertEqual(headers.get("idempotency-replayed"), "true")
        self.cached(path, {"name": "Different"}, "manager", "sprint-security", 409)
        self.api("POST", "/api/boards/1/members", {"user_id": uid, "role": "member"})
        self.cached(path, payload, "manager", "sprint-security", 403)
        self.api("DELETE", f"/api/boards/1/members/{uid}")
        self.cached(path, payload, "manager", "sprint-security", 404)
        self.assertEqual(self.sql("SELECT count(*) FROM sprints WHERE id=?", (initial["id"],))[0][0], 1)

    def test_global_admin_demotion_cannot_replay_a_private_board_operation(self):
        uid = self.add_user("formeradmin", "admin")
        self.login("formeradmin")
        board, _ = self.api("POST", "/api/boards", {"name": "Private administrator board"}, expected=201)
        detail, _ = self.api("GET", f"/api/boards/{board['id']}")
        path, payload = f"/api/columns/{detail['columns'][0]['id']}/cards", {"title": "Private card"}
        created, _ = self.cached(path, payload, "formeradmin", "private-card")
        self.api("PATCH", f"/api/users/{uid}", {"role": "member"})
        self.login("formeradmin")
        self.cached(path, payload, "formeradmin", "private-card", 404)
        self.api("GET", f"/api/cards/{created['id']}", actor="formeradmin", expected=404)

    def test_review_vote_replay_requires_current_reviewer_eligibility(self):
        uid = self.member("reviewer")
        self.member("replacement")
        review, _ = self.api("POST", "/api/cards/1/reviews", {"title": "Approval", "reviewer_ids": [uid]}, expected=201)
        path, payload = f"/api/reviews/{review['id']}/vote", {"decision": "approved", "note": "Reviewed"}
        first, _ = self.cached(path, payload, "reviewer", "vote-security", 200)
        again, _ = self.cached(path, payload, "reviewer", "vote-security", 200)
        self.assertEqual(again, first)
        self.api("PATCH", f"/api/reviews/{review['id']}/reviewers", {"reviewer_ids": [self.sessions['replacement']['id']]})
        self.cached(path, payload, "reviewer", "vote-security", 403)
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes WHERE review_id=?", (review["id"],))[0][0], 0)

    def test_intake_observer_own_replay_and_writer_to_observer_notes(self):
        owner = self.member("requester", "observer")
        writer = self.member("triager")
        board, _ = self.api("GET", "/api/boards/1")
        form, _ = self.api("POST", "/api/boards/1/intake/forms",
                           {"name": "Requests", "column_id": board["columns"][0]["id"]}, expected=201)
        self.api("POST", f"/api/intake/forms/{form['id']}/publish", {})
        path, payload = f"/api/intake/forms/{form['id']}/requests", {"title": "Observer's request", "answers": {}}
        submitted, _ = self.cached(path, payload, "requester", "observer-submission")
        again, _ = self.cached(path, payload, "requester", "observer-submission")
        self.assertEqual(again, submitted)
        note_path = f"/api/intake/requests/{submitted['id']}/notes"
        own_note = {"body": "Own note remains authorized"}
        self.cached(note_path, own_note, "requester", "own-note")
        self.cached(note_path, {"body": "Triage note"}, "triager", "writer-note")
        self.api("POST", "/api/boards/1/members", {"user_id": writer, "role": "observer"})
        self.cached(note_path, {"body": "Triage note"}, "triager", "writer-note", 403)
        self.cached(note_path, own_note, "requester", "own-note")
        self.api("DELETE", f"/api/boards/1/members/{owner}")
        self.cached(path, payload, "requester", "observer-submission", 404)

    def test_personal_template_report_replays_require_current_ownership(self):
        self.member("owner")
        other = self.member("other")
        template_payload = {"name": "Personal template", "card_id": 1}
        template, _ = self.cached("/api/templates/cards", template_payload, "owner", "shared-key")
        report_payload = {"name": "Personal report", "filters": {"q": "My filter"}}
        report, _ = self.cached("/api/me/reports", report_payload, "owner", "shared-key")
        self.cached("/api/templates/cards", template_payload, "owner", "shared-key")
        self.cached("/api/me/reports", report_payload, "owner", "shared-key")
        own_other_report, headers = self.cached("/api/me/reports", report_payload, "other", "shared-key")
        self.assertNotEqual(own_other_report["id"], report["id"])
        self.assertNotIn("idempotency-replayed", headers)
        self.sql("UPDATE templates SET owner_id=? WHERE id=?", (other, template["id"]))
        self.sql("UPDATE saved_reports SET user_id=? WHERE id=?", (other, report["id"]))
        self.cached("/api/templates/cards", template_payload, "owner", "shared-key", 404)
        self.cached("/api/me/reports", report_payload, "owner", "shared-key", 404)

    def test_restored_resource_replay_checks_live_ancestry_and_unknown_paths_fail_closed(self):
        uid = self.member("restorer")
        card, _ = self.api("POST", "/api/columns/1/cards", {"title": "Restorable"}, expected=201)
        self.api("DELETE", f"/api/cards/{card['id']}")
        path = f"/api/cards/{card['id']}/restore"
        first, _ = self.cached(path, {}, "restorer", "restore-security", 200)
        again, _ = self.cached(path, {}, "restorer", "restore-security", 200)
        self.assertEqual(again, first)
        self.api("DELETE", "/api/columns/1")
        self.cached(path, {}, "restorer", "restore-security", 404)
        self.sql("INSERT INTO idempotency(user_id,path,key,request_body,status,response_body) VALUES(?,?,?,?,?,?)",
                 (uid, "/api/future-operation", "unknown-security", "{}", 200, '{"private":"cached"}'))
        self.cached("/api/future-operation", {}, "restorer", "unknown-security", 404)


if __name__ == "__main__":
    unittest.main()
