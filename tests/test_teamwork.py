#!/usr/bin/env python3
"""Time reports and team discussion integration, with real sessions and ACLs."""
import csv
import io
import json
import test_auth as auth_helpers
import unittest
from urllib.parse import quote


class OpenBoardTeamwork(unittest.TestCase):
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
        uid = self.add_user(name, role)
        self.api("POST", f"/api/boards/{board}/members", {"user_id": uid, "role": role})
        self.login(name)
        return uid

    def log_time(self, minutes=30, date="2026-10-14", note="Caffè ☕", card=1, actor="admin", expected=201):
        result, _ = self.api("POST", f"/api/cards/{card}/worklogs", {"minutes": minutes, "date": date, "note": note}, actor=actor, expected=expected)
        return result

    def comment(self, body="Un punto da discutere", actor="admin", card=1):
        result, _ = self.api("POST", f"/api/cards/{card}/comments", {"body": body}, actor=actor, expected=201)
        return result["id"]

    def test_worklog_crud_versions_restore_manual_time_and_card_revision(self):
        before, _ = self.api("GET", "/api/cards/1")
        self.api("PATCH", "/api/cards/1", {"actual_minutes": 15})
        card, _ = self.api("GET", "/api/cards/1")
        entry = self.log_time()
        self.assertEqual(entry["version"], 1)
        self.assertEqual(entry["author"], "Amministratore")
        self.assertEqual(entry["note"], "Caffè ☕")
        after, _ = self.api("GET", "/api/cards/1")
        self.assertEqual(after["version"], card["version"])
        summary, _ = self.api("GET", "/api/cards/1/time-summary")
        self.assertEqual(summary, {"manual_minutes": 15, "logged_minutes": 30, "total_minutes": 45})
        path = f"/api/worklogs/{entry['id']}"
        changed, _ = self.api("PATCH", path, {"minutes": 42, "note": "Updated"}, headers={"If-Match": '"1"'})
        self.assertEqual(changed["version"], 2)
        self.api("PATCH", path, {"minutes": 99}, headers={"If-Match": "1"}, expected=412)
        self.api("DELETE", path, headers={"If-Match": "bad"}, expected=400)
        removed, _ = self.api("DELETE", path, headers={"If-Match": "2"})
        self.assertTrue(removed["deleted_at"])
        self.assertEqual(removed["version"], 3)
        active, _ = self.api("GET", "/api/cards/1/worklogs")
        self.assertEqual(active["items"], [])
        deleted, _ = self.api("GET", "/api/cards/1/worklogs?include_deleted=1")
        self.assertEqual(len(deleted["items"]), 1)
        self.api("PATCH", path, {"minutes": 7}, expected=404)
        self.api("POST", path + "/restore", {}, headers={"If-Match": "2"}, expected=412)
        restored, _ = self.api("POST", path + "/restore", {}, headers={"If-Match": "3"})
        self.assertIsNone(restored["deleted_at"])
        self.assertEqual(restored["version"], 4)
        summary, _ = self.api("GET", "/api/cards/1/time-summary")
        self.assertEqual(summary["total_minutes"], 57)
        self.assertEqual(before["id"], after["id"])

    def test_worklog_validation_pagination_quota_and_idempotency(self):
        for value in (0, -1, 1000001, 1.5, True, "30"):
            self.log_time(minutes=value, expected=400)
        for date in ("2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "0001-01-01", "2026-10-14x"):
            self.log_time(date=date, expected=400)
        self.log_time(date="2000-02-29")
        self.log_time(note="x" * 2001, expected=400)
        first = self.log_time()["id"]
        self.log_time()
        result, _ = self.api("GET", "/api/cards/1/worklogs?limit=2")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["next_cursor"], first)
        page, _ = self.api("GET", f"/api/cards/1/worklogs?limit=2&before={first}")
        self.assertEqual(len(page["items"]), 1)
        for query in ("limit=0", "limit=101", "before=-1", "include_deleted=true", "limit=1&limit=2"):
            self.api("GET", "/api/cards/1/worklogs?" + query, expected=400)
        payload = {"minutes": 12, "date": "2026-10-13"}
        one, _ = self.api("POST", "/api/cards/1/worklogs", payload, expected=201, headers={"Idempotency-Key": "time-unique"})
        two, _ = self.api("POST", "/api/cards/1/worklogs", payload, expected=201, headers={"Idempotency-Key": "time-unique"})
        self.assertEqual(one, two)
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1)UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO worklogs(card_id,user_id,author,date,minutes)SELECT 2,1,'Admin','2026-10-13',1 FROM n")
        self.log_time(card=2, expected=409)

    def test_worklog_owner_observer_and_membership_revocation(self):
        alice = self.member()
        self.member("bob")
        self.member("viewer", "observer")
        entry = self.log_time(actor="alice")
        path = f"/api/worklogs/{entry['id']}"
        for method, payload in (("PATCH", {"minutes": 3}), ("DELETE", None)):
            self.api(method, path, payload, actor="bob", expected=403)
            self.api(method, path, payload, actor="viewer", expected=404)
        self.log_time(actor="viewer", expected=404)
        self.api("GET", "/api/cards/1/worklogs", actor="viewer")
        self.api("PATCH", path, {"minutes": 35})
        self.api("DELETE", f"/api/boards/1/members/{alice}")
        for route in ("/api/cards/1/worklogs", "/api/cards/1/time-summary", "/api/boards/1/time-report"):
            self.api("GET", route, actor="alice", expected=404)
        self.api("PATCH", path, {"minutes": 99}, actor="alice", expected=404)
        summary, _ = self.api("GET", "/api/me/time-report?week=2026-10-14", actor="alice")
        self.assertEqual(summary["total_minutes"], 0)

    def test_board_time_report_range_user_totals_and_safe_csv(self):
        alice = self.member()
        self.log_time(20, "2026-10-12", note='=HYPERLINK("bad")')
        self.log_time(40, "2026-10-13", actor="alice")
        self.log_time(100, "2026-11-01")
        self.api("PATCH", "/api/cards/1", {"title": '  +SUM(1,2) "quoted"\nsecond line'})
        result, _ = self.api("GET", "/api/boards/1/time-report?from=2026-10-01&to=2026-10-31")
        self.assertEqual(result["totals"], {"logged_minutes": 60, "entries": 2})
        self.assertEqual([x["minutes"] for x in result["by_user"]], [20, 40])
        filtered, _ = self.api("GET", f"/api/boards/1/time-report?from=2026-10-01&to=2026-10-31&user_id={alice}")
        self.assertEqual(filtered["totals"]["logged_minutes"], 40)
        exported, headers = self.api("GET", "/api/boards/1/time-export?from=2026-10-01&to=2026-10-31")
        self.assertEqual(exported["filename"], "tempo-bacheca-1.csv")
        rows = list(csv.DictReader(io.StringIO(exported["csv"])))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["note"], '\'=HYPERLINK("bad")')
        self.assertTrue(rows[0]["card_title"].startswith("'  +"))
        self.assertIn('"quoted"\nsecond line', rows[0]["card_title"])
        self.assertEqual(headers["cache-control"], "no-store")
        for query in ("from=2026-10-31&to=2026-10-01", "from=2024-01-01&to=2026-10-31", "from=2026-02-30", "user_id=no", "from=2026-10-01&from=2026-10-02"):
            self.api("GET", "/api/boards/1/time-report?" + query, expected=400)

    def test_personal_week_normalization_excludes_other_users_and_hidden_cards(self):
        self.member()
        self.log_time(10, "2026-10-12", actor="alice")
        self.log_time(20, "2026-10-18", actor="alice")
        self.log_time(90, "2026-10-19", actor="alice")
        self.log_time(500, "2026-10-14")
        result, _ = self.api("GET", "/api/me/time-report?week=2026-10-14", actor="alice")
        self.assertEqual((result["week_start"], result["week_end"]), ("2026-10-12", "2026-10-18"))
        self.assertEqual(result["total_minutes"], 30)
        self.assertEqual(result["daily"], [{"date": "2026-10-12", "minutes": 10}, {"date": "2026-10-18", "minutes": 20}])
        self.api("DELETE", "/api/cards/1")
        result, _ = self.api("GET", "/api/me/time-report?week=2026-10-14", actor="alice")
        self.assertEqual(result["rows"], [])
        self.api("GET", "/api/me/time-report?week=2026-02-30", expected=400)
        self.api("GET", "/api/me/time-report?week=9999-12-31", expected=400)

    def test_reactions_dedup_counts_own_remove_and_observers(self):
        self.member()
        self.member("viewer", "observer")
        comment = self.comment()
        path = f"/api/comments/{comment}/reactions"
        for actor in ("admin", "admin", "alice", "viewer"):
            self.api("POST", path, {"reaction": "heart"}, actor=actor)
        result, _ = self.api("GET", path, actor="viewer")
        self.assertEqual(result, {"items": [{"reaction": "heart", "count": 3, "mine": True}]})
        self.api("DELETE", path, {"reaction": "heart"}, actor="viewer")
        result, _ = self.api("GET", path, actor="viewer")
        self.assertEqual(result["items"][0], {"reaction": "heart", "count": 2, "mine": False})
        self.api("DELETE", path, {"reaction": "heart"}, actor="viewer")
        self.api("POST", path, {"reaction": "arbitrary<script>"}, expected=400)
        self.api("POST", path, {}, expected=400)
        self.api("GET", path, actor=None, expected=401)
        outsider = self.add_user("outside")
        self.login("outside")
        self.api("POST", path, {"reaction": "like"}, actor="outside", expected=404)
        self.assertTrue(outsider)

    def test_pins_version_permission_reactions_in_list_and_unpin(self):
        self.member()
        self.member("viewer", "observer")
        comment = self.comment()
        path = f"/api/comments/{comment}/pin"
        self.api("PATCH", path, {"pinned": True}, actor="viewer", expected=404)
        pinned, _ = self.api("PATCH", path, {"pinned": True}, actor="alice", headers={"If-Match": "1"})
        self.assertTrue(pinned["pinned"])
        self.assertEqual(pinned["version"], 2)
        self.api("PATCH", path, {"pinned": False}, headers={"If-Match": "1"}, expected=412)
        self.api("POST", f"/api/comments/{comment}/reactions", {"reaction": "like"})
        for route in ("/api/cards/1/comments", "/api/cards/1/pinned-comments"):
            result, _ = self.api("GET", route)
            self.assertEqual(result["comments"][0]["reactions"], [{"reaction": "like", "count": 1, "mine": True}])
            self.assertTrue(result["comments"][0]["pinned"])
            self.assertIsNone(result["comments"][0]["parent_id"])
        self.api("PATCH", path, {"pinned": False})
        result, _ = self.api("GET", "/api/cards/1/pinned-comments")
        self.assertEqual(result["comments"], [])

    def test_bookmark_personal_dedup_pagination_and_revocation(self):
        viewer = self.member("viewer", "observer")
        for card in (1, 1, 2, 3):
            self.api("PATCH", f"/api/cards/{card}/bookmark", {"bookmarked": True}, actor="viewer")
        marked, _ = self.api("GET", "/api/cards/1/bookmark", actor="viewer")
        self.assertEqual(marked, {"id": 1, "bookmarked": True})
        unmarked, _ = self.api("GET", "/api/cards/1/bookmark")
        self.assertEqual(unmarked["bookmarked"], False)
        first, _ = self.api("GET", "/api/me/bookmarks?limit=2", actor="viewer")
        self.assertEqual([x["id"] for x in first["items"]], [3, 2])
        page, _ = self.api("GET", f"/api/me/bookmarks?before={first['next_cursor']}", actor="viewer")
        self.assertEqual([x["id"] for x in page["items"]], [1])
        own, _ = self.api("GET", "/api/me/bookmarks")
        self.assertEqual(own["items"], [])
        self.api("PATCH", "/api/cards/1/bookmark", {"bookmarked": False}, actor="viewer")
        self.api("DELETE", "/api/cards/2")
        visible, _ = self.api("GET", "/api/me/bookmarks", actor="viewer")
        self.assertEqual([x["id"] for x in visible["items"]], [3])
        self.api("DELETE", f"/api/boards/1/members/{viewer}")
        hidden, _ = self.api("GET", "/api/me/bookmarks", actor="viewer")
        self.assertEqual(hidden["items"], [])
        self.api("PATCH", "/api/cards/3/bookmark", {"bookmarked": True}, actor="viewer", expected=404)

    def test_thread_replies_flatten_parent_delete_detaches_and_acl(self):
        self.member()
        self.member("viewer", "observer")
        parent = self.comment()
        one, _ = self.api("POST", f"/api/comments/{parent}/replies", {"body": "Prima risposta ☕"}, actor="alice", expected=201)
        two, _ = self.api("POST", f"/api/comments/{one['id']}/replies", {"body": "Seconda risposta"}, expected=201)
        thread, _ = self.api("GET", f"/api/comments/{two['id']}/thread", actor="viewer")
        self.assertEqual(thread["parent"]["id"], parent)
        self.assertEqual([x["id"] for x in thread["replies"]], [one["id"], two["id"]])
        self.api("POST", f"/api/comments/{parent}/replies", {"body": "No"}, actor="viewer", expected=404)
        for body in ("", " \n\t ", "x" * 5001):
            self.api("POST", f"/api/comments/{parent}/replies", {"body": body}, expected=400)
        self.api("DELETE", f"/api/comments/{parent}")
        thread, _ = self.api("GET", f"/api/comments/{one['id']}/thread")
        self.assertIsNone(thread["parent"]["parent_id"])
        self.assertEqual(thread["replies"], [])
        self.api("GET", f"/api/comments/{parent}/thread", expected=404)
        self.api("DELETE", "/api/boards/1")
        self.api("GET", f"/api/comments/{one['id']}/thread", expected=404)

    def test_notifications_filters_search_before_pagination_and_current_acl(self):
        alice = self.member()
        self.api("PATCH", "/api/boards/1/watch", {"watching": True}, actor="alice")
        for title in ("Matching alpha", "Other beta", "Matching gamma", "Other delta", "Matching epsilon"):
            self.api("PATCH", "/api/cards/1", {"title": title})
        result, _ = self.api("GET", "/api/notifications-filtered?q=Matching&limit=2", actor="alice")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["filtered_count"], 3)
        self.assertEqual(result["unread_count"], 5)
        second, _ = self.api("GET", f"/api/notifications-filtered?q=Matching&limit=2&before={result['next_cursor']}", actor="alice")
        self.assertEqual(len(second["items"]), 1)
        self.api("PATCH", f"/api/notifications/{result['items'][0]['id']}", {"read": True}, actor="alice")
        unread, _ = self.api("GET", "/api/notifications-filtered?unread=1&q=Matching", actor="alice")
        self.assertEqual(unread["filtered_count"], 2)
        self.assertEqual(unread["unread_count"], 4)
        for query in ("unread=yes", "unread=1&unread=0", "q=a&q=b", "q=" + quote("☕" * 201)):
            self.api("GET", "/api/notifications-filtered?" + query, actor="alice", expected=400)
        self.api("DELETE", f"/api/boards/1/members/{alice}")
        hidden, _ = self.api("GET", "/api/notifications-filtered?q=Matching", actor="alice")
        self.assertEqual(hidden["items"], [])
        self.assertEqual(hidden["unread_count"], 0)

    def test_teamwork_write_failures_roll_back_insert_and_revision(self):
        self.sql("CREATE TRIGGER fail_time_event BEFORE INSERT ON activity WHEN NEW.action='time_logged' BEGIN SELECT RAISE(ABORT,'test failure');END")
        before = self.sql("SELECT version FROM boards WHERE id=1")[0][0]
        self.log_time(expected=503)
        self.assertEqual(self.sql("SELECT count(*)FROM worklogs")[0][0], 0)
        self.assertEqual(self.sql("SELECT version FROM boards WHERE id=1")[0][0], before)
        self.sql("DROP TRIGGER fail_time_event")
        self.log_time()
        self.api("GET", "/api/ready")


if __name__ == "__main__":
    unittest.main()
