#!/usr/bin/env python3
"""Authenticated iterations, integer capacity and explicit UTC snapshots."""
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import io
import json
import unittest

import test_auth as auth_helpers


class OpenBoardSprints(unittest.TestCase):
    setUp = auth_helpers.OpenBoardAuth.setUp
    stop = auth_helpers.OpenBoardAuth.stop
    read_log = auth_helpers.OpenBoardAuth.read_log
    request = auth_helpers.OpenBoardAuth.request
    api = auth_helpers.OpenBoardAuth.api
    session = auth_helpers.OpenBoardAuth.session
    add_user = auth_helpers.OpenBoardAuth.add_user
    login = auth_helpers.OpenBoardAuth.login
    sql = auth_helpers.OpenBoardAuth.sql

    def board(self, name="Iterazioni"):
        created, _ = self.api("POST", "/api/boards", {"name": name}, expected=201)
        result, _ = self.api("GET", f"/api/boards/{created['id']}")
        return result

    def card(self, board, title="Scheda", **values):
        result, _ = self.api("POST", f"/api/columns/{board['columns'][0]['id']}/cards",
                             {"title": title, **values}, expected=201)
        return result["id"]

    def sprint(self, board=1, name="Sprint uno", **values):
        result, _ = self.api("POST", f"/api/boards/{board}/sprints", {"name": name, **values}, expected=201)
        return result

    def member(self, board, username, role="member", global_role="member"):
        user = self.add_user(username, global_role)
        self.api("POST", f"/api/boards/{board}/members", {"user_id": user, "role": role})
        self.login(username)
        return user

    def call(self, sprint, suffix="", method="GET", payload=None, **options):
        result, _ = self.api(method, f"/api/sprints/{sprint['id']}" + suffix, payload, **options)
        return result

    def test_401_404_create_list_detail_edit_dates_versions_idempotency(self):
        sprint = self.sprint(goal="Release di novembre", start_date="2028-02-29", end_date="2028-03-15")
        self.assertEqual((sprint["state"], sprint["version"], sprint["creator_id"]), ("planned", 1, 1))
        self.assertEqual(sprint["permissions"], {"manage": True, "schedule": True})
        self.assertEqual(self.call(sprint), sprint)
        other = self.sprint(name="Secondo")
        page, _ = self.api("GET", "/api/boards/1/sprints?limit=1")
        self.assertEqual([s["id"] for s in page["items"]], [other["id"]])
        self.assertEqual(page["next_cursor"], other["id"])
        older, _ = self.api("GET", f"/api/boards/1/sprints?before={page['next_cursor']}")
        self.assertEqual([s["id"] for s in older["items"]], [sprint["id"]])
        search, _ = self.api("GET", "/api/boards/1/sprints?q=novembre&state=planned")
        self.assertEqual([s["id"] for s in search["items"]], [sprint["id"]])
        changed = self.call(sprint, method="PATCH", payload={"name": "Revised", "goal": "", "end_date": "2028-04-01"}, headers={"If-Match": '"1"'})
        self.assertEqual((changed["version"], changed["name"], changed["goal"], changed["start_date"]), (2, "Revised", "", "2028-02-29"))
        self.call(sprint, method="PATCH", payload={"name": "Stale"}, headers={"If-Match": "1"}, expected=412)
        self.call(sprint, method="PATCH", payload={"name": "Bad"}, headers={"If-Match": 'W/"2"'}, expected=400)
        payload = {"name": "Idempotent"}
        one, _ = self.api("POST", "/api/boards/1/sprints", payload, headers={"Idempotency-Key": "sprint-create"}, expected=201)
        two, _ = self.api("POST", "/api/boards/1/sprints", payload, headers={"Idempotency-Key": "sprint-create"}, expected=201)
        self.assertEqual(one, two)
        self.api("POST", "/api/boards/1/sprints", {"name": "Other"}, headers={"Idempotency-Key": "sprint-create"}, expected=409)

    def test_405_409_lifecycle_one_active_close_keeps_unfinished_history(self):
        board = self.board()
        card = self.card(board, estimate_minutes=20)
        first, second = self.sprint(board["id"]), self.sprint(board["id"], "Two")
        self.call(first, "/cards", "POST", {"card_id": card})
        self.assertEqual(self.call(first, "/activate", "POST", {})["state"], "active")
        self.call(second, "/activate", "POST", {}, expected=409)
        self.assertEqual(self.call(first, "/close", "POST", {})["state"], "closed")
        live_card, _ = self.api("GET", f"/api/cards/{card}")
        self.assertFalse(live_card["completed"])
        self.assertEqual(self.call(first, "/progress")["open"], 1)
        self.call(first, "/cards", "POST", {"card_id": card}, expected=409)
        self.call(first, method="PATCH", payload={"name": "Closed edit"}, expected=409)
        self.call(second, "/cards", "POST", {"card_id": card})
        self.call(first, "/reopen", "POST", {}, expected=409)
        self.call(second, "/cards/" + str(card), "DELETE")
        self.assertEqual(self.call(first, "/reopen", "POST", {})["state"], "planned")
        self.call(first, method="DELETE")
        self.call(first, expected=404)
        self.assertIsNotNone(self.call(first, "?include_deleted=1")["deleted_at"])
        self.call(second, "/cards", "POST", {"card_id": card})
        self.call(first, "/restore", "POST", {}, expected=409)
        self.call(second, "/cards/" + str(card), "DELETE")
        self.assertIsNone(self.call(first, "/restore", "POST", {})["deleted_at"])
        self.call(first, "/restore", "POST", {}, expected=409)
        self.call(first, "/close", "POST", {}, expected=409)
        self.call(first, "/reopen", "POST", {}, expected=409)

    def test_410_415_membership_bulk_atomic_backlog_filters_cursor(self):
        board, other_board = self.board(), self.board("Foreign")
        alice = self.member(board["id"], "alice")
        sprint = self.sprint(board["id"])
        ids = [self.card(board, title, priority="high", assignee_ids=[alice], completed=(title == "Done"), blocked_reason="Wait" if title == "Blocked" else "")
               for title in ("Caffè 100% _", "Done", "Blocked", "Fourth")]
        foreign = self.card(other_board)
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": [ids[0], foreign]}, expected=404)
        self.assertEqual(self.call(sprint, "/cards")["items"], [])
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": ids}, actor="alice")
        self.call(sprint, "/cards", "POST", {"card_id": ids[0]}, expected=409)
        page = self.call(sprint, "/cards?limit=2")
        self.assertEqual([c["id"] for c in page["items"]], ids[-1:-3:-1])
        self.assertEqual([c["id"] for c in self.call(sprint, f"/cards?limit=2&before={page['next_cursor']}")["items"]], ids[-3::-1])
        self.assertEqual([c["id"] for c in self.call(sprint, "/cards?q=100%25+_&status=open&priority=high&assignee_id=" + str(alice))["items"]], [ids[0]])
        self.assertEqual([c["id"] for c in self.call(sprint, "/cards?status=blocked")["items"]], [ids[2]])
        self.assertEqual([c["id"] for c in self.call(sprint, "/cards?status=completed")["items"]], [ids[1]])
        self.call(sprint, "/cards/bulk", "DELETE", {"card_ids": [ids[0], foreign]}, expected=404)
        self.assertEqual(len(self.call(sprint, "/cards")["items"]), 4)
        self.call(sprint, "/cards/bulk", "DELETE", {"card_ids": ids[:2]})
        backlog, _ = self.api("GET", f"/api/boards/{board['id']}/backlog")
        self.assertEqual([c["id"] for c in backlog["items"]], ids[1::-1])
        self.call(sprint, "/cards/" + str(ids[2]), "DELETE")
        self.call(sprint, "/cards/" + str(ids[2]), "DELETE", expected=409)
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": []}, expected=400)
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": [ids[0], ids[0]]}, expected=400)
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": list(range(1, 102))}, expected=400)

    def test_416_417_421_422_capacity_split_real_worklogs_revocations_forecast(self):
        board = self.board()
        alice, bob = self.member(board["id"], "alice"), self.member(board["id"], "bob")
        sprint = self.sprint(board["id"])
        shared = self.card(board, "Shared", estimate_minutes=101, actual_minutes=9, assignee_ids=[alice, bob])
        done = self.card(board, "Done", estimate_minutes=20, completed=True, assignee_ids=[alice])
        unassigned = self.card(board, "No estimate")
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": [shared, done, unassigned]})
        absent = self.call(sprint, "/forecast")
        self.assertFalse(absent["capacity_configured"])
        self.assertEqual((absent["capacity_user_count"], absent["unestimated_cards"]), (0, 1))
        self.call(sprint, f"/capacity/{alice}", "PATCH", {"minutes": 0})
        zero = self.call(sprint, "/forecast")
        self.assertTrue(zero["capacity_configured"])
        self.assertEqual((zero["capacity_user_count"], zero["capacity_minutes"]), (1, 0))
        self.api("POST", f"/api/cards/{shared}/worklogs", {"minutes": 10, "note": "Working", "date": str(datetime.now(timezone.utc).date())}, expected=201)
        self.call(sprint, f"/capacity/{alice}", "PATCH", {"minutes": 30})
        self.call(sprint, f"/capacity/{bob}", "PATCH", {"minutes": 40})
        totals = self.call(sprint, "/progress")
        self.assertEqual((totals["total"], totals["completed"], totals["open"]), (3, 1, 2))
        self.assertEqual((totals["estimate_minutes"], totals["completed_estimate_minutes"], totals["remaining_minutes"], totals["logged_minutes"]), (121, 20, 82, 19))
        self.assertEqual(totals["completion_percent"], 33.33)
        report = self.call(sprint, "/capacity-report")
        by_id = {r["user_id"]: r for r in report["items"]}
        self.assertEqual((by_id[alice]["assigned_minutes"], by_id[bob]["assigned_minutes"]), (71, 50))
        self.assertEqual((by_id[alice]["logged_minutes"], by_id[bob]["logged_minutes"]), (10, 9))
        self.assertEqual((by_id[alice]["remaining_minutes"], by_id[bob]["remaining_minutes"]), (41, 41))
        self.assertTrue(by_id[alice]["over_capacity"])
        self.assertEqual(report["totals"]["capacity_minutes"], 70)
        forecast = self.call(sprint, "/forecast")
        self.assertEqual((forecast["capacity_gap_minutes"], forecast["estimate_missing"]), (12, 1))
        self.assertEqual((forecast["capacity_user_count"], forecast["unestimated_cards"]), (2, 1))
        self.api("DELETE", f"/api/boards/{board['id']}/members/{bob}")
        self.assertNotIn(bob, {r["user_id"] for r in self.call(sprint, "/capacity")["items"]})
        self.assertEqual(self.call(sprint, "/forecast")["capacity_minutes"], 30)
        self.api("POST", f"/api/boards/{board['id']}/members", {"user_id": bob, "role": "member"})
        self.assertEqual({r["user_id"]: r["minutes"] for r in self.call(sprint, "/capacity")["items"]}[bob], 0)
        self.api("PATCH", f"/api/users/{alice}", {"active": False})
        self.assertNotIn(alice, {r["user_id"] for r in self.call(sprint, "/capacity")["items"]})

    def test_historical_membership_conflicts_survive_archives_and_card_list_restores(self):
        for hidden in ("archived_card", "deleted_card", "deleted_column"):
            with self.subTest(hidden=hidden):
                board = self.board(hidden)
                card = self.card(board)
                first, second = self.sprint(board["id"]), self.sprint(board["id"], "Next")
                self.call(first, "/cards", "POST", {"card_id": card})
                self.call(first, "/activate", "POST", {})
                self.call(first, "/close", "POST", {})
                self.call(second, "/cards", "POST", {"card_id": card})
                column = board["columns"][0]["id"]

                def hide():
                    if hidden == "archived_card":
                        self.api("PATCH", f"/api/cards/{card}", {"archived": True})
                    else:
                        self.api("DELETE", f"/api/{'columns' if hidden == 'deleted_column' else 'cards'}/{column if hidden == 'deleted_column' else card}")

                def restore():
                    if hidden == "archived_card":
                        self.api("PATCH", f"/api/cards/{card}", {"archived": False})
                    else:
                        self.api("POST", f"/api/{'columns' if hidden == 'deleted_column' else 'cards'}/{column if hidden == 'deleted_column' else card}/restore", {})

                hide()
                self.call(first, "/reopen", "POST", {}, expected=409)
                self.assertEqual(self.call(first)["state"], "closed")
                restore()
                self.call(second, f"/cards/{card}", "DELETE")
                self.call(first, "/reopen", "POST", {})
                self.call(first, method="DELETE")
                self.call(second, "/cards", "POST", {"card_id": card})
                hide()
                self.call(first, "/restore", "POST", {}, expected=409)
                restore()
                self.call(second, f"/cards/{card}", "DELETE")
                self.call(first, "/restore", "POST", {})
                memberships = self.sql("SELECT count(*) FROM sprint_cards sc JOIN sprints s ON s.id=sc.sprint_id WHERE sc.card_id=? AND s.deleted_at IS NULL AND s.state<>'closed'", (card,))
                self.assertEqual(memberships, [(1,)])

    def test_418_420_snapshots_explicit_utc_replacement_corrections_no_get_writes(self):
        board = self.board()
        card = self.card(board, estimate_minutes=55)
        sprint = self.sprint(board["id"])
        self.call(sprint, "/cards", "POST", {"card_id": card})
        self.call(sprint, "/snapshots", "POST", {}, expected=409)
        activated = self.call(sprint, "/activate", "POST", {})
        before = self.sql("SELECT version,(SELECT count(*) FROM sprint_events WHERE sprint_id=s.id) FROM sprints s WHERE id=?", (sprint["id"],))
        self.assertEqual(self.call(sprint, "/snapshots")["items"], [])
        self.call(sprint, "/progress")
        self.assertEqual(before, self.sql("SELECT version,(SELECT count(*) FROM sprint_events WHERE sprint_id=s.id) FROM sprints s WHERE id=?", (sprint["id"],)))
        captured = self.call(sprint, "/snapshots", "POST", {}, headers={"If-Match": str(activated["version"])})
        rows = self.call(sprint, "/snapshots")["items"]
        today = str(datetime.now(timezone.utc).date())
        self.assertEqual((rows[0]["day"], rows[0]["total"], rows[0]["completed"], rows[0]["remaining_minutes"]), (today, 1, 0, 55))
        self.api("PATCH", f"/api/cards/{card}", {"completed": True})
        self.call(sprint, "/snapshots", "POST", {}, expected=409)
        self.call(sprint, "/snapshots", "POST", {}, headers={"If-Match": str(activated["version"])}, expected=412)
        replaced = self.call(sprint, "/snapshots", "POST", {}, headers={"If-Match": str(captured["version"])})
        rows = self.call(sprint, "/snapshots")["items"]
        self.assertEqual((len(rows), rows[0]["completed"], rows[0]["remaining_minutes"]), (1, 1, 0))
        self.call(sprint, "/snapshots", "POST", {"day": "1999-01-01"}, expected=400)
        self.call(sprint, "/snapshots/2026-02-30", "DELETE", expected=400)
        self.call(sprint, "/close", "POST", {})
        self.call(sprint, "/snapshots/" + today, "DELETE")
        self.assertEqual(self.call(sprint, "/snapshots")["items"], [])
        self.call(sprint, "/snapshots/" + today, "DELETE", expected=404)
        self.assertGreater(replaced["version"], captured["version"])

    def test_423_my_active_tasks_live_acl_and_ancestry(self):
        board, foreign_board = self.board(), self.board("Hidden")
        alice = self.member(board["id"], "alice")
        sprint, hidden = self.sprint(board["id"]), self.sprint(foreign_board["id"])
        card, foreign = self.card(board, assignee_ids=[alice]), self.card(foreign_board)
        self.sql("INSERT INTO card_assignees(card_id,user_id) VALUES(?,?)", (foreign, alice))
        self.call(sprint, "/cards", "POST", {"card_id": card})
        self.call(hidden, "/cards", "POST", {"card_id": foreign})
        self.call(sprint, "/activate", "POST", {})
        self.call(hidden, "/activate", "POST", {})
        inbox, _ = self.api("GET", "/api/me/sprint-tasks", actor="alice")
        self.assertEqual([c["id"] for c in inbox["items"]], [card])
        self.assertEqual((inbox["items"][0]["sprint_id"], inbox["items"][0]["sprint_name"]), (sprint["id"], "Sprint uno"))
        self.api("DELETE", f"/api/boards/{board['id']}/members/{alice}")
        self.assertEqual(self.api("GET", "/api/me/sprint-tasks", actor="alice")[0]["items"], [])
        self.member(board["id"], "bob")
        # Imported or administrator-repaired relations still obey current ancestry.
        self.sql("UPDATE cards SET column_id=? WHERE id=?", (foreign_board["columns"][0]["id"], card))
        self.assertEqual(self.call(sprint, "/cards")["items"], [])
        self.assertEqual(self.call(sprint, "/progress")["total"], 0)

    def test_424_425_csv_formula_safety_real_counts_history_cursor(self):
        board = self.board()
        self.api("PATCH", f"/api/columns/{board['columns'][0]['id']}", {"title": " @column"})
        sprint = self.sprint(board["id"])
        titles = ['  =SUM(1,2)', 'quote " and\nnewline', '+formula', '-formula', '@formula']
        cards = [self.card(board, title, estimate_minutes=10, actual_minutes=3, assignee="\t=Alice") for title in titles]
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": cards})
        exported = self.call(sprint, "/export?limit=1&before=1")
        self.assertFalse(exported["truncated"])
        rows = list(csv.DictReader(io.StringIO(exported["csv"])))
        self.assertEqual([int(r["id"]) for r in rows], cards[::-1])
        self.assertEqual([int(r["logged_minutes"]) for r in rows], [3] * 5)
        self.assertTrue(all(r["column"].startswith("'") and r["assignee"].startswith("'") for r in rows))
        self.assertEqual(rows[-1]["title"], "'" + titles[0])
        self.assertEqual(rows[-2]["title"], titles[1])
        first = self.call(sprint, "/history?limit=1")
        self.assertEqual(first["items"][0]["action"], "sprint_cards_added")
        second = self.call(sprint, "/history?before=" + str(first["next_cursor"]))
        self.assertEqual(second["items"][0]["action"], "sprint_created")
        self.assertIsNone(second["next_cursor"])
        self.call(sprint, method="DELETE")
        self.assertEqual(self.call(sprint, "/history")["items"][0]["action"], "sprint_deleted")

    def test_auth_observers_managers_revocation_and_deleted_ancestry(self):
        board = self.board()
        alice = self.member(board["id"], "alice")
        watcher = self.member(board["id"], "watcher", role="observer")
        outsider = self.add_user("outsider")
        self.login("outsider")
        sprint = self.sprint(board["id"])
        for suffix in ("", "/cards", "/progress", "/forecast", "/capacity", "/capacity-report", "/snapshots", "/history", "/export"):
            self.call(sprint, suffix, actor=None, expected=401)
            self.call(sprint, suffix, actor="outsider", expected=404)
            self.call(sprint, suffix, actor="watcher")
        self.assertFalse(self.call(sprint, actor="watcher")["permissions"]["schedule"])
        self.call(sprint, method="PATCH", payload={"name": "No"}, actor="alice", expected=403)
        self.call(sprint, "/activate", "POST", {}, actor="alice", expected=403)
        self.call(sprint, "/cards", "POST", {"card_id": 1}, actor="watcher", expected=403)
        self.api("POST", f"/api/boards/{board['id']}/sprints", {"name": "No"}, actor="watcher", expected=403)
        self.api("POST", f"/api/boards/{board['id']}/members", {"user_id": alice, "role": "admin"})
        self.assertTrue(self.call(sprint, actor="alice")["permissions"]["manage"])
        self.call(sprint, method="PATCH", payload={"goal": "Admin member"}, actor="alice")
        self.api("PATCH", f"/api/users/{alice}", {"role": "observer"})
        self.assertFalse(self.call(sprint, actor="alice")["permissions"]["manage"])
        self.call(sprint, "/activate", "POST", {}, actor="alice", expected=403)
        self.call(sprint, f"/capacity/{watcher}", "PATCH", {"minutes": 10}, expected=400)
        self.api("DELETE", f"/api/boards/{board['id']}")
        self.call(sprint, expected=404)
        self.call(sprint, "/history", expected=404)

    def test_validation_no_coercion_unknown_keys_and_query_limits(self):
        for payload in ({"name": ""}, {"name": "  "}, {"name": "x" * 121}, {"name": "N", "goal": "x" * 4001},
                        {"name": "N", "start_date": "2026-02-29"}, {"name": "N", "end_date": "2026-02-30"},
                        {"name": "N", "start_date": "2026-11-02", "end_date": "2026-11-01"},
                        {"name": "N", "board_id": 2}, {"name|goal": "N"}, {"name": None}):
            self.api("POST", "/api/boards/1/sprints", payload, expected=400)
        sprint = self.sprint()
        for query in ("limit=0", "limit=101", "limit=true", "before=0", "include_deleted=yes", "state=no", "limit=1&limit=2", "q=" + "x" * 201):
            self.api("GET", "/api/boards/1/sprints?" + query, expected=400)
        for query in ("q=" + "x" * 201, "status=bad", "priority=critical", "assignee_id=0", "limit=101", "q=%00"):
            self.call(sprint, "/cards?" + query, expected=400)
        for payload in ({"card_id": True}, {"card_id": "1"}, {"card_id": 1.0}, {"card_id": 1, "state": "active"}):
            self.call(sprint, "/cards", "POST", payload, expected=400)
        for minutes in (-1, True, "1", 1.5, 1000001):
            self.call(sprint, "/capacity/1", "PATCH", {"minutes": minutes}, expected=400)
        self.call(sprint, method="PATCH", payload={}, expected=400)
        self.call(sprint, method="PATCH", payload={"start_date": "2099-01-01", "end_date": "2000-01-01"}, expected=400)
        self.call(sprint, "/activate", "POST", {"state": "active"}, expected=400)
        self.call(sprint, method="DELETE", payload={"unexpected": True}, expected=400)

    def test_mutations_atomic_on_history_failure_and_bulk_write_failure(self):
        board = self.board()
        sprint = self.sprint(board["id"])
        one, two = self.card(board, "One"), self.card(board, "Two")
        self.sql(f"CREATE TRIGGER fail_second_sprint_card BEFORE INSERT ON sprint_cards WHEN NEW.card_id={two} BEGIN SELECT RAISE(ABORT,'test failure');END")
        self.call(sprint, "/cards/bulk", "POST", {"card_ids": [one, two]}, expected=503)
        self.assertEqual(self.call(sprint, "/cards")["items"], [])
        self.assertEqual(self.call(sprint)["version"], 1)
        self.sql("DROP TRIGGER fail_second_sprint_card")
        self.sql("CREATE TRIGGER fail_sprint_event BEFORE INSERT ON sprint_events BEGIN SELECT RAISE(ABORT,'test failure');END")
        self.call(sprint, method="PATCH", payload={"name": "Rollback"}, expected=503)
        self.assertEqual((self.call(sprint)["name"], self.call(sprint)["version"]), ("Sprint uno", 1))
        self.call(sprint, "/cards", "POST", {"card_id": one}, expected=503)
        self.assertEqual(self.call(sprint, "/cards")["items"], [])

    def test_concurrent_versioned_edits_and_active_sprint_unique(self):
        first, second = self.sprint(name="One"), self.sprint(name="Two")
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}",
                   "Cookie": self.sessions["admin"]["cookie"], "X-CSRF-Token": self.sessions["admin"]["csrf"], "If-Match": "1"}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda name: self.request("PATCH", f"/api/sprints/{first['id']}", json.dumps({"name": name}).encode(), headers)[0], ["Edit A", "Edit B"]))
        self.assertEqual(sorted(results), [200, 412])
        headers.pop("If-Match")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda s: self.request("POST", f"/api/sprints/{s['id']}/activate", b"{}", headers)[0], [first, second]))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(self.sql("SELECT count(*) FROM sprints WHERE board_id=1 AND state='active' AND deleted_at IS NULL")[0][0], 1)

    def test_quotas_events_sprints_cards_snapshots_and_csv_reject_overflow(self):
        board = self.board()
        sprint = self.sprint(board["id"])
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<199) INSERT INTO sprints(board_id,creator_id,name) SELECT ?,1,'Quota'||x FROM n", (board["id"],))
        self.api("POST", f"/api/boards/{board['id']}/sprints", {"name": "Overflow"}, expected=409)
        column = board["columns"][0]["id"]
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO cards(column_id,title,position) SELECT ?,'Quota'||x,x FROM n", (column,))
        self.sql("INSERT INTO sprint_cards(sprint_id,card_id) SELECT ?,id FROM cards WHERE column_id=?", (sprint["id"], column))
        self.call(sprint, "/export", expected=413)
        free = self.card(board, "Extra")
        self.call(sprint, "/cards", "POST", {"card_id": free}, expected=409)
        self.call(sprint, "/activate", "POST", {})
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<366) INSERT INTO sprint_snapshots(sprint_id,day,total,completed,estimate_minutes,completed_estimate_minutes,remaining_minutes,logged_minutes) SELECT ?,date('now','-'||x||' days'),0,0,0,0,0,0 FROM n", (sprint["id"],))
        self.call(sprint, "/snapshots", "POST", {}, expected=409)
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO sprint_events(sprint_id,actor,action) SELECT ?,'System','quota' FROM n", (sprint["id"],))
        self.call(sprint, method="PATCH", payload={"name": "Full"}, expected=409)
        self.call(sprint, method="DELETE", expected=409)


if __name__ == "__main__":
    unittest.main()
