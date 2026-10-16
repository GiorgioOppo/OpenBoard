#!/usr/bin/env python3
"""Review lifecycles, current membership authorization and transactional safety."""
import csv
import io
import sqlite3
import unittest

import test_auth as auth_helpers


class OpenBoardReviews(unittest.TestCase):
    setUp = auth_helpers.OpenBoardAuth.setUp
    stop = auth_helpers.OpenBoardAuth.stop
    read_log = auth_helpers.OpenBoardAuth.read_log
    request = auth_helpers.OpenBoardAuth.request
    api = auth_helpers.OpenBoardAuth.api
    session = auth_helpers.OpenBoardAuth.session
    add_user = auth_helpers.OpenBoardAuth.add_user
    login = auth_helpers.OpenBoardAuth.login
    sql = auth_helpers.OpenBoardAuth.sql

    def member(self, username, role="member", board=1, global_role=None):
        uid = self.add_user(username, global_role or role)
        self.api("POST", f"/api/boards/{board}/members", {"user_id": uid, "role": role})
        self.login(username)
        return uid

    def create(self, reviewers=None, actor="admin", card=1, **fields):
        if reviewers is None:
            reviewers = [self.alice]
        payload = {"title": "Controllo qualità", "reviewer_ids": reviewers, **fields}
        result, _ = self.api("POST", f"/api/cards/{card}/reviews", payload, actor=actor, expected=201)
        return result

    def actor_vote(self, review, actor="alice", decision="approved", note="", version=None, expected=200):
        headers = {} if version is None else {"If-Match": str(version)}
        result, _ = self.api("POST", f"/api/reviews/{review}/vote", {"decision": decision, "note": note}, actor=actor, headers=headers, expected=expected)
        return result

    def test_create_details_list_summary_stats_and_current_permissions(self):
        self.alice = self.member("alice")
        review = self.create(description="Controllare accessibilità e qualità", due_date="2000-02-29")
        self.assertEqual(review["status"], "pending")
        self.assertEqual(review["version"], 1)
        self.assertTrue(review["overdue"])
        self.assertTrue(review["can_manage"])
        self.assertFalse(review["can_vote"])
        self.assertEqual(review["reviewers"], [{"user_id": self.alice, "name": "Alice", "username": "alice", "eligible": True, "decision": None, "note": "", "voted_at": None}])
        detail, _ = self.api("GET", f"/api/reviews/{review['id']}", actor="alice")
        self.assertTrue(detail["can_vote"])
        self.assertFalse(detail["can_manage"])
        listed, _ = self.api("GET", "/api/cards/1/reviews")
        self.assertEqual(listed["items"], [review])
        self.assertIsNone(listed["next_cursor"])
        for path in ("/api/cards/1/review-summary", "/api/boards/1/review-stats"):
            data, _ = self.api("GET", path)
            self.assertEqual(data, {"total": 1, "pending": 1, "approved": 0, "changes_requested": 0, "cancelled": 0, "overdue": 1})
        board, _ = self.api("GET", "/api/boards/1")
        self.assertGreater(board["version"], 1)

    def test_all_any_changes_requested_precedence_and_own_vote_withdrawal(self):
        self.alice = self.member("alice")
        bob = self.member("bob")
        review = self.create([self.alice, bob])
        review = self.actor_vote(review["id"], version=1)
        self.assertEqual((review["status"], review["approved_count"]), ("pending", 1))
        review = self.actor_vote(review["id"], actor="bob", version=2)
        self.assertEqual(review["status"], "approved")
        review = self.actor_vote(review["id"], actor="bob", decision="changes_requested", note="Serve un test reale", version=3)
        self.assertEqual((review["status"], review["changes_count"]), ("changes_requested", 1))
        review, _ = self.api("DELETE", f"/api/reviews/{review['id']}/vote", actor="bob", headers={"If-Match": '"4"'})
        self.assertEqual(review["status"], "pending")
        self.api("DELETE", f"/api/reviews/{review['id']}/vote", actor="bob", expected=409)
        any_review = self.create([self.alice, bob], policy="any")
        any_review = self.actor_vote(any_review["id"])
        self.assertEqual(any_review["status"], "approved")
        any_review = self.actor_vote(any_review["id"], actor="bob", decision="changes_requested", note="Correggere contrasto")
        self.assertEqual(any_review["status"], "changes_requested")

    def test_edit_reviewers_and_policy_reset_votes_with_optimistic_conflicts(self):
        self.alice = self.member("alice")
        bob = self.member("bob")
        review = self.create()
        review = self.actor_vote(review["id"])
        path = f"/api/reviews/{review['id']}"
        self.api("PATCH", path, {"title": "Obsoleto"}, headers={"If-Match": "1"}, expected=412)
        self.api("PATCH", path, {"title": "Non valido"}, headers={"If-Match": "x"}, expected=400)
        self.api("PATCH", path, {}, expected=400)
        edited, _ = self.api("PATCH", path, {"title": "Revisione finale", "description": "Nuovo testo", "due_date": "", "policy": "any"}, headers={"If-Match": '"2"'})
        self.assertEqual((edited["status"], edited["approved_count"], edited["version"]), ("pending", 0, 3))
        self.assertEqual(edited["description"], "Nuovo testo")
        self.actor_vote(review["id"])
        replaced, _ = self.api("PATCH", path + "/reviewers", {"reviewer_ids": [bob]}, headers={"If-Match": "4"})
        self.assertEqual((replaced["version"], replaced["approved_count"]), (5, 0))
        self.assertEqual(replaced["reviewers"][0]["user_id"], bob)
        self.actor_vote(review["id"], expected=403)
        self.api("PATCH", path + "/reviewers", {"reviewer_ids": [bob, bob]}, expected=400)
        after, _ = self.api("GET", path)
        self.assertEqual(after, replaced)

    def test_cancel_reopen_soft_delete_restore_and_history_cursor(self):
        self.alice = self.member("alice")
        review = self.create()
        self.actor_vote(review["id"])
        path = f"/api/reviews/{review['id']}"
        cancelled, _ = self.api("POST", path + "/cancel", {}, headers={"If-Match": "2"})
        self.assertEqual(cancelled["status"], "cancelled")
        self.actor_vote(review["id"], expected=409)
        self.api("POST", path + "/cancel", {}, expected=409)
        reopened, _ = self.api("POST", path + "/reopen", {}, headers={"If-Match": "3"})
        self.assertEqual((reopened["status"], reopened["approved_count"]), ("pending", 0))
        deleted, _ = self.api("DELETE", path, headers={"If-Match": "4"})
        self.assertTrue(deleted["deleted_at"])
        self.api("GET", path, expected=404)
        self.api("PATCH", path, {"title": "No"}, expected=404)
        self.actor_vote(review["id"], expected=404)
        active, _ = self.api("GET", "/api/cards/1/reviews")
        self.assertEqual(active["items"], [])
        trashed, _ = self.api("GET", "/api/cards/1/reviews?include_deleted=1")
        self.assertEqual(trashed["items"], [deleted])
        self.api("POST", path + "/restore", {}, headers={"If-Match": "4"}, expected=412)
        restored, _ = self.api("POST", path + "/restore", {}, headers={"If-Match": "5"})
        self.assertIsNone(restored["deleted_at"])
        self.assertEqual(restored["version"], 6)
        history, _ = self.api("GET", path + "/history?limit=2")
        self.assertEqual([e["action"] for e in history["items"]], ["review_restored", "review_deleted"])
        self.assertTrue(history["next_cursor"])
        older, _ = self.api("GET", path + f"/history?limit=100&before={history['next_cursor']}")
        self.assertEqual([e["action"] for e in older["items"]], ["review_reopened", "review_cancelled", "review_voted", "review_created"])
        self.assertIsNone(older["next_cursor"])

    def test_filters_deterministic_pages_personal_inbox_and_membership_revocation(self):
        self.alice = self.member("alice")
        bob = self.member("bob")
        first = self.create(due_date="2000-01-01")
        second = self.create([bob], due_date="2099-01-01")
        third = self.create([self.alice, bob], policy="any")
        self.actor_vote(third["id"])
        mine, _ = self.api("GET", "/api/me/reviews", actor="alice")
        self.assertEqual([r["id"] for r in mine["items"]], [third["id"], first["id"]])
        filtered, _ = self.api("GET", f"/api/boards/1/reviews?overdue=1&status=pending&reviewer_id={self.alice}&requester_id=1")
        self.assertEqual([r["id"] for r in filtered["items"]], [first["id"]])
        page, _ = self.api("GET", "/api/boards/1/reviews?limit=2")
        self.assertEqual([r["id"] for r in page["items"]], [third["id"], second["id"]])
        self.assertEqual(page["next_cursor"], second["id"])
        last, _ = self.api("GET", f"/api/boards/1/reviews?limit=2&before={page['next_cursor']}")
        self.assertEqual([r["id"] for r in last["items"]], [first["id"]])
        for query in ("limit=101", "before=0", "overdue=true", "status=unknown", "reviewer_id=-1", "requester_id=0", "include_deleted=2"):
            self.api("GET", "/api/boards/1/reviews?" + query, expected=400)
        self.api("DELETE", f"/api/boards/1/members/{self.alice}")
        self.api("GET", f"/api/reviews/{first['id']}", actor="alice", expected=404)
        mine, _ = self.api("GET", "/api/me/reviews", actor="alice")
        self.assertEqual(mine["items"], [])

    def test_revoked_or_inactive_reviewer_never_produces_false_approval(self):
        self.alice = self.member("alice")
        bob = self.member("bob")
        review = self.create([self.alice, bob])
        self.actor_vote(review["id"])
        self.actor_vote(review["id"], actor="bob")
        self.api("DELETE", f"/api/boards/1/members/{bob}")
        resolved, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual((resolved["status"], resolved["reviewer_count"], resolved["approved_count"]), ("pending", 2, 1))
        self.assertFalse(resolved["reviewers"][1]["eligible"])
        self.assertEqual(resolved["version"], 4)
        self.api("PATCH", f"/api/reviews/{review['id']}", {"title": "Stale"}, headers={"If-Match": "3"}, expected=412)
        audit, _ = self.api("GET", f"/api/reviews/{review['id']}/history?limit=1")
        self.assertEqual(audit["items"][0]["action"], "review_eligibility_changed")
        self.assertEqual(audit["items"][0]["actor"], "Sistema")
        self.assertIsNone(audit["items"][0]["actor_id"])
        self.assertEqual(audit["items"][0]["subject_id"], bob)
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes WHERE user_id=?", (bob,)), [(0,)])
        self.api("POST", "/api/boards/1/members", {"user_id": bob, "role": "member"})
        rejoined, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual((rejoined["status"], rejoined["approved_count"]), ("pending", 1))
        self.actor_vote(review["id"], actor="bob")
        self.api("PATCH", f"/api/users/{bob}", {"active": False})
        resolved, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual(resolved["status"], "pending")
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes WHERE user_id=?", (bob,)), [(0,)])
        self.api("PATCH", f"/api/users/{bob}", {"active": True, "role": "observer"})
        resolved, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual(resolved["status"], "pending")
        self.assertFalse(resolved["reviewers"][1]["eligible"])
        self.api("PATCH", f"/api/users/{bob}", {"role": "member"})
        self.login("bob")
        self.actor_vote(review["id"], actor="bob")
        self.api("POST", "/api/boards/1/members", {"user_id": bob, "role": "observer"})
        downgraded, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual(downgraded["status"], "pending")
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes WHERE user_id=?", (bob,)), [(0,)])

    def test_requester_board_manager_observers_cross_board_and_self_approval_acl(self):
        self.alice = self.member("alice")
        manager_id = self.member("manager", "admin", global_role="member")
        self.member("observer", "observer")
        self.member("outsider", board=2)
        review = self.create(actor="alice", reviewers=[1])
        path = f"/api/reviews/{review['id']}"
        self.api("PATCH", path, {"title": "Dal responsabile"}, actor="manager")
        detail, _ = self.api("GET", path, actor="manager")
        self.assertTrue(detail["can_manage"])
        self.assertFalse(detail["can_vote"])
        self.actor_vote(review["id"], actor="alice", expected=403)
        self.actor_vote(review["id"], actor="manager", expected=403)
        self.api("PATCH", path, {"title": "No"}, actor="observer", expected=404)
        observed, _ = self.api("GET", path, actor="observer")
        self.assertFalse(observed["can_manage"])
        self.api("GET", path, actor="outsider", expected=404)
        self.api("GET", "/api/boards/1/review-stats", actor="outsider", expected=404)
        self.api("GET", "/api/boards/1/review-export", actor="outsider", expected=404)
        self.api("POST", "/api/cards/1/reviews", {"title": "Self", "reviewer_ids": [1]}, expected=400)
        self.api("POST", "/api/boards/1/members", {"user_id": self.alice, "role": "observer"})
        detail, _ = self.api("GET", path, actor="alice")
        listed, _ = self.api("GET", "/api/cards/1/reviews", actor="alice")
        self.assertFalse(detail["can_manage"])
        self.assertFalse(listed["items"][0]["can_manage"])
        self.api("PATCH", path, {"title": "No"}, actor="alice", expected=404)
        self.assertNotEqual(manager_id, 1)

    def test_creation_and_vote_validation_and_real_csrf(self):
        self.alice = self.member("alice")
        self.member("observer", "observer")
        invalid = (
            {"title": " "}, {"title": "x" * 201}, {"description": "x" * 4001},
            {"due_date": "2026-02-29"}, {"due_date": "1900-02-29"}, {"policy": "majority"},
            {"reviewer_ids": []}, {"reviewer_ids": [self.alice] * 21},
            {"reviewer_ids": [True]}, {"reviewer_ids": [float(self.alice)]},
            {"reviewer_ids": [str(self.alice)]}, {"reviewer_ids": [1]},
            {"reviewer_ids": [999]}, {"reviewer_ids": [self.sessions["observer"]["id"]]},
        )
        for values in invalid:
            with self.subTest(values=values):
                self.api("POST", "/api/cards/1/reviews", {"title": "Valida", "reviewer_ids": [self.alice], **values}, expected=400)
        review = self.create(due_date="2000-02-29")
        self.api("GET", f"/api/reviews/{review['id']}", actor=None, expected=401)
        self.api("POST", f"/api/reviews/{review['id']}/vote", {"decision": "approved"}, actor="alice", headers={"X-CSRF-Token": ""}, expected=403)
        for decision, note in (("maybe", ""), ("changes_requested", ""), ("changes_requested", " \n\t"), ("approved", "x" * 2001)):
            self.actor_vote(review["id"], decision=decision, note=note, expected=400)
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes"), [(0,)])
        self.assertEqual(self.sql("SELECT count(*) FROM review_events"), [(1,)])

    def test_duplicate_same_board_resets_votes_and_export_is_safe_csv(self):
        self.alice = self.member("alice")
        review = self.create(title=' =HYPERLINK("evil")', description='@danger\n"Quoted", text')
        self.actor_vote(review["id"])
        card, _ = self.api("GET", "/api/cards/1")
        target, _ = self.api("POST", f"/api/columns/{card['column_id']}/cards", {"title": "+Formula"}, expected=201)
        copy, _ = self.api("POST", f"/api/reviews/{review['id']}/duplicate", {"card_id": target["id"]}, headers={"If-Match": "2"}, expected=201)
        self.assertEqual((copy["status"], copy["approved_count"], copy["version"]), ("pending", 0, 1))
        self.assertEqual(copy["title"], review["title"])
        self.assertEqual(copy["card_id"], target["id"])
        other, _ = self.api("GET", "/api/boards/2")
        foreign, _ = self.api("POST", f"/api/columns/{other['columns'][0]['id']}/cards", {"title": "Altra bacheca"}, expected=201)
        self.api("POST", f"/api/reviews/{review['id']}/duplicate", {"card_id": foreign["id"]}, expected=404)
        exported, headers = self.api("GET", "/api/boards/1/review-export")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(exported["filename"], "revisioni-bacheca-1.csv")
        rows = list(csv.DictReader(io.StringIO(exported["csv"])))
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0]["card_title"].startswith("'+"))
        self.assertTrue(rows[0]["title"].startswith("' ="))
        self.assertTrue(rows[0]["description"].startswith("'@"))
        filtered, _ = self.api("GET", "/api/boards/1/review-export?status=approved")
        self.assertEqual(len(list(csv.DictReader(io.StringIO(filtered["csv"])))), 1)

    def test_idempotency_atomic_failure_and_quotas(self):
        self.alice = self.member("alice")
        payload = {"title": "Unica", "reviewer_ids": [self.alice]}
        headers = {"Idempotency-Key": "review-creation-123"}
        first, _ = self.api("POST", "/api/cards/1/reviews", payload, headers=headers, expected=201)
        replay, _ = self.api("POST", "/api/cards/1/reviews", payload, headers=headers, expected=201)
        self.assertEqual(first, replay)
        self.assertEqual(self.sql("SELECT count(*) FROM reviews"), [(1,)])
        self.api("POST", "/api/cards/1/reviews", {**payload, "title": "Diversa"}, headers=headers, expected=409)
        with sqlite3.connect(self.db) as connection:
            connection.executescript("CREATE TRIGGER fail_review_event BEFORE INSERT ON review_events WHEN NEW.action='review_voted' BEGIN SELECT RAISE(ABORT,'injected review failure'); END;")
        self.actor_vote(first["id"], expected=503)
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes"), [(0,)])
        self.assertEqual(self.sql("SELECT version FROM reviews"), [(1,)])
        with sqlite3.connect(self.db) as connection:
            connection.execute("DROP TRIGGER fail_review_event")
            connection.executemany("INSERT INTO reviews(card_id,requester_id,title) VALUES(1,1,'quota')", [()] * 199)
        self.api("POST", "/api/cards/1/reviews", payload, expected=409)
        self.api("POST", f"/api/reviews/{first['id']}/duplicate", {"card_id": 1}, expected=409)
        with sqlite3.connect(self.db) as connection:
            connection.executemany("INSERT INTO review_events(review_id,actor_id,actor,action) VALUES(?,1,'Admin','quota')", [(first["id"],)] * 9999)
        self.actor_vote(first["id"], expected=409)
        self.assertEqual(self.sql("SELECT count(*) FROM review_votes"), [(0,)])

    def test_deleted_parent_hides_reviews_and_observer_global_cannot_vote(self):
        self.alice = self.member("alice")
        review = self.create()
        self.api("PATCH", f"/api/users/{self.alice}", {"role": "observer"})
        self.actor_vote(review["id"], expected=404)
        detail, _ = self.api("GET", f"/api/reviews/{review['id']}", actor="alice")
        self.assertFalse(detail["can_vote"])
        self.api("DELETE", "/api/cards/1")
        for endpoint in (f"/api/reviews/{review['id']}", f"/api/reviews/{review['id']}/history", "/api/cards/1/reviews", "/api/cards/1/review-summary"):
            self.api("GET", endpoint, expected=404)
        stats, _ = self.api("GET", "/api/boards/1/review-stats")
        self.assertEqual(stats["total"], 0)


if __name__ == "__main__":
    unittest.main()
