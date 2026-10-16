#!/usr/bin/env python3
"""Cross-board reporting uses live permissions and deterministic real data."""
import csv
from datetime import datetime, timedelta, timezone
import io
import json
import unittest
from urllib.parse import urlencode

import test_auth as auth_helpers


class OpenBoardPortfolio(unittest.TestCase):
    setUp = auth_helpers.OpenBoardAuth.setUp
    stop = auth_helpers.OpenBoardAuth.stop
    read_log = auth_helpers.OpenBoardAuth.read_log
    request = auth_helpers.OpenBoardAuth.request
    api = auth_helpers.OpenBoardAuth.api
    session = auth_helpers.OpenBoardAuth.session
    add_user = auth_helpers.OpenBoardAuth.add_user
    login = auth_helpers.OpenBoardAuth.login
    sql = auth_helpers.OpenBoardAuth.sql

    def board(self, name="Portfolio"):
        result, _ = self.api("POST", "/api/boards", {"name": name}, expected=201)
        result, _ = self.api("GET", f"/api/boards/{result['id']}")
        return result

    def card(self, board, title="Scheda", **values):
        result, _ = self.api("POST", f"/api/columns/{board['columns'][0]['id']}/cards",
                             {"title": title, **values}, expected=201)
        return result["id"]

    def get(self, endpoint="cards", actor="admin", **filters):
        path = "/api/portfolio" + ("/" + endpoint if endpoint else "")
        result, _ = self.api("GET", path + ("?" + urlencode(filters) if filters else ""), actor=actor)
        return result

    def report(self, name="Da seguire", **values):
        result, _ = self.api("POST", "/api/me/reports", {"name": name, **values}, expected=201)
        return result

    def test_326_327_summary_includes_empty_boards_with_real_card_metrics(self):
        self.sql("DELETE FROM boards")
        board = self.board()
        empty = self.board("Empty")
        self.card(board, "Open", estimate_minutes=25, actual_minutes=10)
        self.card(board, "Done", completed=True)
        result = self.get("")
        self.assertEqual(result["summary"]["boards"], 2)
        self.assertEqual((result["summary"]["total"], result["summary"]["open"], result["summary"]["completed"]), (2, 1, 1))
        self.assertEqual((result["summary"]["estimate_minutes"], result["summary"]["total_minutes"]), (25, 10))
        by_id = {item["id"]: item for item in result["boards"]}
        self.assertEqual(by_id[empty["id"]]["total"], 0)
        self.assertEqual(by_id[board["id"]]["name"], "Portfolio")
        self.assertFalse(result["boards_truncated"])

    def test_328_334_search_status_assignee_priority_label_board_dates(self):
        self.sql("DELETE FROM boards")
        board = self.board()
        other = self.board("Other")
        alice = self.add_user("alice")
        self.api("POST", f"/api/boards/{board['id']}/members", {"user_id": alice, "role": "member"})
        today = datetime.now(timezone.utc).date()
        soon = str(today + timedelta(days=3))
        overdue = str(today - timedelta(days=2))
        selected = self.card(board, "Caffè 100% _report", description="release plan", priority="urgent",
                             labels=["design", "urgente"], due_date=soon, assignee_ids=[alice])
        done = self.card(board, "Finished", completed=True, due_date=overdue)
        blocked = self.card(board, "Blocked", blocked_reason="Waiting", due_date=overdue)
        free = self.card(other, "Free")
        self.assertEqual([c["id"] for c in self.get(q="100% _")['items']], [selected])
        self.assertEqual(self.get(q="%does-not-match")['items'], [])
        self.assertEqual([c["id"] for c in self.get(q="RELEASE PLAN")['items']], [selected])
        for status, ids in (("open", [free, blocked, selected]), ("completed", [done]),
                            ("blocked", [blocked]), ("overdue", [blocked]), ("due_soon", [selected]),
                            ("unassigned", [free, blocked])):
            self.assertEqual([c["id"] for c in self.get(status=status)['items']], ids)
        result = self.get(assignee_id=alice, priority="urgent", label="design", board_id=board["id"],
                          **{"from": str(today), "to": soon})
        self.assertEqual([c["id"] for c in result["items"]], [selected])
        item = result["items"][0]
        self.assertEqual((item["board_name"], item["board_id"]), ("Portfolio", board["id"]))
        self.assertEqual(item["assignees"][0]["id"], alice)
        self.assertEqual(self.get(priority="low")["items"], [])
        self.assertEqual(self.get(assignee_id=999999)["items"], [])

    def test_335_stable_cursor_and_350_formula_safe_csv_use_same_filters(self):
        self.sql("DELETE FROM boards")
        board = self.board(' \t=BAD("board")')
        self.api("PATCH", f"/api/columns/{board['columns'][0]['id']}", {"title": "@column"})
        titles = ["normal", '  +SUM(1,2) "quotes"\nnext', "-formula", "@formula", "=formula"]
        ids = [self.card(board, title, priority="high") for title in titles]
        first = self.get(limit=2)
        self.assertEqual([c["id"] for c in first["items"]], ids[-1:-3:-1])
        self.assertEqual(first["next_cursor"], ids[-2])
        fresh = self.card(board, "New arrival")
        second = self.get(limit=2, before=first["next_cursor"])
        self.assertEqual([c["id"] for c in second["items"]], ids[-3:-5:-1])
        self.assertNotIn(fresh, [c["id"] for c in second["items"]])
        exported = self.get("export", priority="high", limit=100)
        self.assertEqual(exported["filename"], "portfolio.csv")
        self.assertIsNone(exported["next_cursor"])
        rows = list(csv.DictReader(io.StringIO(exported["csv"])))
        self.assertEqual([int(r["id"]) for r in rows], list(reversed(ids)))
        for row in rows:
            self.assertTrue(row["board"].startswith("'"))
            self.assertEqual(row["column"], "'@column")
        self.assertEqual(rows[-2]["title"], "'" + titles[1])
        self.assertEqual(rows[-1]["title"], "normal")
        exported = self.get("export", limit=2)
        self.assertIsNotNone(exported["next_cursor"])
        self.assertEqual(len(list(csv.DictReader(io.StringIO(exported["csv"])))), 2)

    def test_live_ancestry_archived_and_deleted_are_consistent(self):
        self.sql("DELETE FROM boards")
        active, archived, deleted, hidden_column = (self.board(name) for name in ("Active", "Archived", "Deleted", "Hidden column"))
        live = self.card(active)
        ac = self.card(active, "Archived card", archived=True)
        ab = self.card(archived)
        gone = self.card(deleted)
        hc = self.card(hidden_column)
        self.api("PATCH", f"/api/boards/{archived['id']}", {"archived": True})
        self.api("DELETE", f"/api/boards/{deleted['id']}")
        self.api("DELETE", f"/api/columns/{hidden_column['columns'][0]['id']}")
        self.assertEqual([c["id"] for c in self.get()["items"]], [live])
        self.assertEqual([c["id"] for c in self.get(include_archived=1)["items"]], [ab, ac, live])
        self.assertEqual(self.get("")["summary"]["total"], 1)
        self.assertEqual(self.get("", include_archived=1)["summary"]["total"], 3)
        self.assertEqual(self.get("insights")["time"]["total_minutes"], 0)
        self.assertNotIn(gone, [c["id"] for c in self.get(include_archived=1)["items"]])
        self.assertNotIn(hc, [c["id"] for c in self.get(include_archived=1)["items"]])

    def test_auth_acl_revocation_applies_to_all_portfolio_data_and_saved_filters(self):
        alice = self.add_user("alice")
        self.login("alice")
        for endpoint in ("", "cards", "insights", "export"):
            self.api("GET", "/api/portfolio" + ("/" + endpoint if endpoint else ""), actor=None, expected=401)
        for endpoint in ("", "cards", "insights", "export"):
            result = self.get(endpoint, actor="alice")
            if endpoint == "":
                self.assertEqual(result["summary"]["boards"], 0)
                self.assertEqual(result["users"], [])
            elif endpoint == "cards":
                self.assertEqual(result["items"], [])
            elif endpoint == "insights":
                self.assertEqual(sum(day["count"] for day in result["activity"]), 0)
                self.assertEqual(result["milestones"], [])
            else:
                self.assertEqual(len(list(csv.DictReader(io.StringIO(result["csv"])))), 0)
        self.api("POST", "/api/boards/1/members", {"user_id": alice, "role": "observer"})
        visible = self.get("", actor="alice")
        self.assertEqual([b["id"] for b in visible["boards"]], [1])
        self.assertIn(alice, [u["id"] for u in visible["users"]])
        report, _ = self.api("POST", "/api/me/reports", {"name": "Saved access", "filters": {"board_id": 1}}, actor="alice", expected=201)
        self.api("DELETE", f"/api/boards/1/members/{alice}")
        self.assertEqual(self.get(actor="alice", board_id=1)["items"], [])
        self.assertEqual(self.get("", actor="alice", board_id=1)["summary"]["boards"], 0)
        stored, _ = self.api("GET", f"/api/reports/{report['id']}", actor="alice")
        self.assertEqual(stored["filters"], {"board_id": 1})

    def test_336_341_personal_report_crud_versions_duplication_pins_owner(self):
        alice = self.add_user("alice", "observer")
        self.login("alice")
        filters = {"q": "Caffè", "status": "open", "priority": "high", "include_archived": True, "limit": 50}
        one = self.report(filters=filters)
        two = self.report("Pinned", pinned=True)
        result, _ = self.api("GET", "/api/me/reports")
        self.assertEqual([r["id"] for r in result["reports"]], [two["id"], one["id"]])
        self.assertEqual(result["reports"][1]["filters"], filters)
        path = f"/api/reports/{one['id']}"
        changed, _ = self.api("PATCH", path, {"name": "Revised", "filters": {"status": "blocked"}, "pinned": True}, headers={"If-Match": '"1"'})
        self.assertEqual((changed["version"], changed["name"], changed["pinned"]), (2, "Revised", True))
        self.assertEqual(changed["filters"], {"status": "blocked"})
        self.api("PATCH", path, {"name": "Stale"}, headers={"If-Match": "1"}, expected=412)
        self.api("DELETE", path, headers={"If-Match": "bad"}, expected=400)
        duplicate, _ = self.api("POST", path + "/duplicate", {}, headers={"If-Match": "2"}, expected=201)
        self.assertEqual((duplicate["name"], duplicate["version"], duplicate["pinned"]), ("Revised (copia)", 1, False))
        self.assertEqual(duplicate["filters"], changed["filters"])
        named, _ = self.api("POST", path + "/duplicate", {"name": "Copy"}, expected=201)
        self.assertEqual(named["name"], "Copy")
        for method, payload in (("GET", None), ("PATCH", {"name": "Stolen"}), ("DELETE", None)):
            self.api(method, path, payload, actor="alice", expected=404)
        self.api("POST", path + "/duplicate", {}, actor="alice", expected=404)
        self.api("PATCH", path, {"user_id": alice}, expected=400)
        self.api("PATCH", path, {"pinned": False})
        self.api("DELETE", path, headers={"If-Match": "2"}, expected=412)
        self.api("DELETE", path, headers={"If-Match": "3"})
        self.api("GET", path, expected=404)
        personal, _ = self.api("POST", "/api/me/reports", {"name": "Observer's report"}, actor="alice", expected=201)
        self.api("PATCH", f"/api/reports/{personal['id']}", {"pinned": True}, actor="alice")
        self.api("DELETE", f"/api/reports/{personal['id']}", actor="alice")

    def test_query_and_saved_filter_validation_no_coercion_no_unknown_keys(self):
        for query in ("limit=0", "limit=101", "limit=true", "before=0", "before=-1", "board_id=bad", "assignee_id=0",
                      "status=unknown", "priority=critical", "label=unknown", "include_archived=true", "from=2026-02-29",
                      "to=2026-02-30", "from=2026-10-10&to=2026-10-01", "q=" + "x" * 201,
                      "limit=1&limit=2", "status=all&status=open", "q=%00evil"):
            self.api("GET", "/api/portfolio/cards?" + query, expected=400)
        invalid = [{"unknown": 1}, {"q|status": "x"}, {"status": "unknown"}, {"priority": "critical"}, {"label": "unknown"},
                   {"board_id": "1"}, {"assignee_id": True}, {"limit": 101}, {"limit": 0}, {"limit": 2.5},
                   {"include_archived": 1}, {"include_archived": "true"}, {"q": "x" * 201}, {"q": "nul\0"},
                   {"q": None}, {"from": "2026-02-29"}, {"from": "2026-10-10", "to": "2026-10-01"}, {"before": 2}]
        for filters in invalid:
            self.api("POST", "/api/me/reports", {"name": "Invalid", "filters": filters}, expected=400)
        for payload in ({"name": ""}, {"name": " \t"}, {"name": "x" * 101}, {"name": "Valid", "filters": []},
                        {"name": "Valid", "pinned": 1}, {"name": "Valid", "user_id": 1}):
            self.api("POST", "/api/me/reports", payload, expected=400)
        report = self.report()
        self.api("PATCH", f"/api/reports/{report['id']}", {}, expected=400)
        raw = b'{"name":"Duplicate","filters":{"q":"a","q":"b"}}'
        headers = {"Content-Type": "application/json", "Cookie": self.sessions["admin"]["cookie"],
                   "X-CSRF-Token": self.sessions["admin"]["csrf"], "Origin": f"http://127.0.0.1:{self.port}"}
        self.assertEqual(self.request("POST", "/api/me/reports", raw, headers)[0], 400)

    def test_342_349_insights_activity_aging_capacity_effort_wip_checklists_dependencies_milestones(self):
        self.sql("DELETE FROM boards")
        board = self.board()
        alice = self.add_user("alice")
        self.api("POST", f"/api/boards/{board['id']}/members", {"user_id": alice, "role": "member"})
        today = datetime.now(timezone.utc).date()
        col = board["columns"][0]["id"]
        self.api("PATCH", f"/api/columns/{col}", {"wip_limit": 3})
        milestone, _ = self.api("POST", f"/api/boards/{board['id']}/milestones", {"key": "release", "title": "Release", "due_date": str(today - timedelta(days=1))}, expected=201)
        a = self.card(board, "A", estimate_minutes=60, actual_minutes=10, due_date=str(today - timedelta(days=3)), assignee_ids=[alice],
                      checklist=[{"id": "first", "text": "First", "done": True}, {"id": "second", "text": "Second", "done": False}], milestone_key="release")
        b = self.card(board, "B", estimate_minutes=30, due_date=str(today - timedelta(days=15)), milestone_key="release")
        self.card(board, "C", estimate_minutes=20, due_date=str(today - timedelta(days=45)))
        self.card(board, "Done", completed=True, estimate_minutes=10, actual_minutes=5, milestone_key="release")
        self.api("POST", f"/api/cards/{a}/worklogs", {"date": str(today), "minutes": 25}, expected=201)
        self.api("POST", f"/api/cards/{a}/dependencies", {"required_card_id": b}, expected=201)
        result = self.get("insights")
        self.assertEqual(len(result["activity"]), 30)
        self.assertEqual(result["activity"][0]["date"], str(today - timedelta(days=29)))
        self.assertEqual(result["activity"][-1]["date"], str(today))
        actual_count = self.sql("SELECT count(*) FROM activity WHERE board_id=? AND substr(created_at,1,10)=?", (board["id"], str(today)))[0][0]
        self.assertEqual(result["activity"][-1]["count"], actual_count)
        self.assertEqual(result["overdue_buckets"], [{"bucket": "1-7", "count": 1}, {"bucket": "8-30", "count": 1}, {"bucket": "31+", "count": 1}])
        capacity = {r["user_id"]: r for r in result["capacity"]}
        self.assertEqual((capacity[alice]["cards"], capacity[alice]["estimate_minutes"], capacity[alice]["total_minutes"]), (1, 60, 35))
        self.assertEqual(capacity[0]["cards"], 2)
        self.assertEqual(result["time"], {"estimate_minutes": 120, "manual_minutes": 15, "logged_minutes": 25, "total_minutes": 40, "variance_minutes": -80})
        self.assertEqual(result["checklists"], {"total": 2, "done": 1})
        self.assertEqual((result["bottlenecks"][0]["column_id"], result["bottlenecks"][0]["open"], result["bottlenecks"][0]["over_limit"]), (col, 3, 0))
        self.assertEqual(result["dependency_blocks"], [{"id": a, "title": "A", "board_id": board["id"], "board_name": "Portfolio", "remaining": 1}])
        m = result["milestones"][0]
        self.assertEqual((m["id"], m["total"], m["done"], m["overdue"]), (milestone["id"], 3, 1, True))
        filtered = self.get("insights", status="completed")
        self.assertEqual(filtered["time"]["total_minutes"], 5)
        self.assertEqual(filtered["capacity"], [])
        self.assertEqual(filtered["checklists"], {"total": 0, "done": 0})
        self.api("PATCH", f"/api/cards/{b}", {"completed": True})
        self.assertEqual(self.get("insights")["dependency_blocks"], [])

    def test_100_reports_quota_blocks_create_and_duplicate_without_modifying_original(self):
        report = self.report()
        self.sql("WITH RECURSIVE n(x)AS(VALUES(1)UNION ALL SELECT x+1 FROM n WHERE x<99) "
                 "INSERT INTO saved_reports(user_id,name)SELECT 1,'Report '||x FROM n")
        self.api("POST", "/api/me/reports", {"name": "Overflow"}, expected=409)
        self.api("POST", f"/api/reports/{report['id']}/duplicate", {}, expected=409)
        self.api("PATCH", f"/api/reports/{report['id']}", {"name": "Still editable"})
        result, _ = self.api("GET", "/api/me/reports")
        self.assertEqual(len(result["reports"]), 100)


if __name__ == "__main__":
    unittest.main()
