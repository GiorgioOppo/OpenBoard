#!/usr/bin/env python3
"""Productivity features: transactional batches, dependency graphs and private resources."""
from concurrent.futures import ThreadPoolExecutor
import json
import unittest

import test_api
import test_auth


class OpenBoardProductivity(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api
    create_board = test_api.OpenBoardAPI.create_board
    create_card = test_api.OpenBoardAPI.create_card
    board = test_api.OpenBoardAPI.board

    def versions(self, *ids):
        return [{"id": cid, "version": self.api("GET", f"/api/cards/{cid}")["version"]} for cid in ids]

    def test_card_fields_validation_partial_dates_and_export_import(self):
        board = self.create_board()
        col = board["columns"][0]["id"]
        fields = {"start_date": "2028-02-29", "due_date": "2028-03-01", "blocked_reason": "Attesa revisione ☕",
                  "actual_minutes": 135, "reference_url": "https://example.org/path?q=1#details"}
        card = self.create_card(col, "Planning", **fields)
        for path in (f"/api/cards/{card}",):
            detail = self.api("GET", path)
            for key, value in fields.items():
                self.assertEqual(detail[key], value)
        summary = self.api("GET", f"/api/boards/{board['id']}?summary=1")["columns"][0]["cards"][0]
        self.assertEqual(summary["actual_minutes"], 135)
        for payload in ({"start_date": "2027-02-29"}, {"start_date": "2028-03-02"}, {"due_date": "2028-02-28"},
                        {"blocked_reason": "x"*1001}, {"actual_minutes": -1}, {"actual_minutes": 1000001},
                        {"actual_minutes": 1.5}, {"reference_url": "javascript:alert(1)"},
                        {"reference_url": "https://example.org/\nunsafe"}, {"reference_url": "https://user:pass@example.org"}):
            self.api("PATCH", f"/api/cards/{card}", payload, expected=400)
        exported = self.api("GET", f"/api/boards/{board['id']}/export")
        imported = self.api("POST", "/api/import", exported, expected=201)
        clone = self.board(imported["id"])["columns"][0]["cards"][0]
        for key, value in fields.items():
            self.assertEqual(clone[key], value)
        duplicate = self.api("POST", f"/api/boards/{board['id']}/duplicate", {}, expected=201)
        self.assertEqual(self.board(duplicate["id"])["columns"][0]["cards"][0]["actual_minutes"], 135)
        self.api("PATCH", f"/api/cards/{card}", {"start_date": "", "due_date": "", "reference_url": "", "actual_minutes": 0})
        self.assertEqual(self.api("GET", f"/api/cards/{card}")["start_date"], "")

    def test_dependency_cycles_completion_and_deleted_prerequisites(self):
        board = self.create_board()
        col = board["columns"][0]["id"]
        a, b, c = [self.create_card(col, title) for title in ("A", "B", "C")]
        self.api("POST", f"/api/cards/{a}/dependencies", {"required_card_id": b}, expected=201)
        self.api("POST", f"/api/cards/{b}/dependencies", {"required_card_id": c}, expected=201)
        self.api("POST", f"/api/cards/{c}/dependencies", {"required_card_id": a}, expected=409)
        self.api("POST", f"/api/cards/{a}/dependencies", {"required_card_id": a}, expected=400)
        self.api("PATCH", f"/api/cards/{a}", {"completed": True}, expected=409)
        self.api("PATCH", f"/api/cards/{b}", {"completed": True}, expected=409)
        self.api("PATCH", f"/api/cards/{c}", {"completed": True})
        self.api("PATCH", f"/api/cards/{b}", {"completed": True})
        self.assertEqual(self.api("GET", f"/api/cards/{a}/dependencies")["dependencies"], [{"id": b, "title": "B", "completed": True}])
        self.api("DELETE", f"/api/cards/{b}")
        self.api("PATCH", f"/api/cards/{a}", {"completed": True}, expected=409)
        self.api("DELETE", f"/api/cards/{a}/dependencies/{b}")
        self.api("PATCH", f"/api/cards/{a}", {"completed": True})
        other = self.create_board()["columns"][0]["id"]
        foreign = self.create_card(other, "Another board")
        self.api("POST", f"/api/cards/{a}/dependencies", {"required_card_id": foreign}, expected=400)

    def test_dependency_parallel_cycle_serialization(self):
        col = self.create_board()["columns"][0]["id"]
        a, b = [self.create_card(col, x) for x in ("A", "B")]
        def link(pair):
            x, y = pair
            return self.request("POST", f"/api/cards/{x}/dependencies", json.dumps({"required_card_id": y}).encode(),
                                {"Content-Type": "application/json"})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(link, [(a,b), (b,a)])), [201, 409])

    def test_card_templates_snapshot_wip_and_delete(self):
        board = self.create_board()
        col, target = [x["id"] for x in board["columns"][:2]]
        card = self.create_card(col, "Template source", description="Reusable", start_date="2026-11-01", due_date="2026-11-03",
                                blocked_reason="Review", actual_minutes=8, checklist=[{"id":"a","text":"Step","done":False}])
        template = self.api("POST", "/api/templates/cards", {"card_id": card, "name": "Reusable card"}, expected=201)["id"]
        self.api("PATCH", f"/api/cards/{card}", {"title": "Changed source"})
        self.assertEqual(self.api("GET", "/api/templates/cards")["templates"][0]["name"], "Reusable card")
        clone = self.api("POST", f"/api/templates/cards/{template}/instantiate", {"column_id": target}, expected=201)["id"]
        self.assertEqual(self.api("GET", f"/api/cards/{clone}")["title"], "Template source")
        self.api("PATCH", f"/api/columns/{target}", {"wip_limit": 1})
        self.api("POST", f"/api/templates/cards/{template}/instantiate", {"column_id": target}, expected=409)
        self.api("DELETE", f"/api/templates/cards/{template}")
        self.assertEqual(self.api("GET", "/api/templates/cards")["templates"], [])
        self.api("POST", f"/api/templates/cards/{template}/instantiate", {"column_id": target}, expected=404)

    def test_board_templates_preserve_structure_and_values(self):
        board = self.create_board("Reusable project")
        col = board["columns"][0]["id"]
        self.api("PATCH", f"/api/columns/{col}", {"wip_limit": 4})
        self.create_card(col, "Blueprint", actual_minutes=12, reference_url="http://example.org")
        tid = self.api("POST", "/api/templates/boards", {"board_id": board["id"], "name": "Project plan"}, expected=201)["id"]
        self.api("DELETE", f"/api/boards/{board['id']}")
        created = self.api("POST", f"/api/templates/boards/{tid}/instantiate", {"name":"New project"}, expected=201)
        clone = self.board(created["id"])
        self.assertEqual(clone["name"], "New project")
        self.assertEqual(len(clone["columns"]), 3)
        self.assertEqual(clone["columns"][0]["wip_limit"], 4)
        self.assertEqual(clone["columns"][0]["cards"][0]["actual_minutes"], 12)
        self.api("DELETE", f"/api/templates/boards/{tid}")
        self.assertEqual(self.api("GET", "/api/templates/boards")["templates"], [])

    def test_saved_filters_validate_rename_persist_and_delete(self):
        board = self.create_board()
        path = f"/api/boards/{board['id']}/views"
        filters = {"query":"Caffè", "label":"design", "status":"overdue", "sort":"priority"}
        view = self.api("POST", path, {"name":"My view", "filters": filters}, expected=201)["id"]
        self.api("PATCH", f"/api/views/{view}", {"name":"Renamed"})
        self.stop_server(); self.start_server()
        saved = self.api("GET", path)["views"]
        self.assertEqual(saved, [{"id":view, "name":"Renamed", "filters":filters}])
        for invalid in ({"sql":"DROP TABLE cards"}, {"priority":"invalid"}, {"sort":"random"}, {"query":12}):
            self.api("PATCH", f"/api/views/{view}", {"filters":invalid}, expected=400)
        self.api("DELETE", f"/api/views/{view}")
        self.assertEqual(self.api("GET", path)["views"], [])

    def test_bulk_dependencies_versions_wip_and_atomic_rollback(self):
        board = self.create_board()
        bid, col = board["id"], board["columns"][0]["id"]
        a, b = [self.create_card(col, x) for x in ("A", "B")]
        self.api("POST", f"/api/cards/{a}/dependencies", {"required_card_id": b}, expected=201)
        before = self.board(bid)
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"complete","value":True,"cards":self.versions(a)}, expected=409)
        self.assertEqual(self.board(bid), before)
        batch = self.versions(a,b)
        self.api("PATCH", f"/api/cards/{b}", {"description":"New revision"})
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"complete","value":True,"cards":batch}, expected=412)
        self.assertFalse(self.api("GET", f"/api/cards/{a}")["completed"])
        self.assertEqual(self.api("POST", f"/api/boards/{bid}/bulk", {"action":"complete","value":True,"cards":self.versions(a,b)})["updated"], 2)
        self.api("PATCH", f"/api/columns/{col}", {"wip_limit":1})
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"complete","value":False,"cards":self.versions(a,b)}, expected=409)
        self.assertTrue(self.api("GET", f"/api/cards/{b}")["completed"])
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"archive","value":True,"cards":self.versions(a,b)})
        self.assertEqual(self.board(bid)["columns"][0]["cards"], [])
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"archive","value":False,"cards":self.versions(a,b)})
        self.assertEqual(len(self.board(bid)["columns"][0]["cards"]), 2)
        for payload in ({"action":"unknown","value":True,"cards":self.versions(a)},
                        {"action":"complete","value":True,"cards":[]},
                        {"action":"complete","value":True,"cards":["bad"]},
                        {"action":"complete","value":True,"cards":[{"id":a}]},
                        {"action":"complete","value":True,"cards":{}},
                        {"action":"archive","value":True,"cards":[{"id":a,"version":1},{"id":a,"version":1}]}):
            self.api("POST", f"/api/boards/{bid}/bulk", payload, expected=400)

    def test_bulk_wip_checks_only_affected_columns(self):
        board = self.create_board()
        bid = board["id"]
        crowded, target = [x["id"] for x in board["columns"][:2]]
        self.create_card(crowded, "Existing one")
        self.create_card(crowded, "Existing two")
        self.api("PATCH", f"/api/columns/{crowded}", {"wip_limit":1})
        card = self.create_card(target, "Reopen elsewhere", completed=True)
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"complete","value":False,"cards":self.versions(card)})
        self.assertFalse(self.api("GET", f"/api/cards/{card}")["completed"])
        self.api("PATCH", f"/api/cards/{card}", {"archived":True})
        self.api("POST", f"/api/boards/{bid}/bulk", {"action":"archive","value":False,"cards":self.versions(card)})
        self.assertFalse(self.api("GET", f"/api/cards/{card}")["archived"])


class OpenBoardProductivityAuth(unittest.TestCase):
    setUp = test_auth.OpenBoardAuth.setUp
    stop = test_auth.OpenBoardAuth.stop
    read_log = test_auth.OpenBoardAuth.read_log
    request = test_auth.OpenBoardAuth.request
    api = test_auth.OpenBoardAuth.api
    session = test_auth.OpenBoardAuth.session
    add_user = test_auth.OpenBoardAuth.add_user
    login = test_auth.OpenBoardAuth.login
    sql = test_auth.OpenBoardAuth.sql

    def test_multi_assignees_my_tasks_and_access_revocation(self):
        uid = self.add_user("member")
        other = self.add_user("outsider")
        self.login("member")
        board, _ = self.api("POST", "/api/boards", {"name":"Private"}, expected=201)
        bid = board["id"]
        board, _ = self.api("GET", f"/api/boards/{bid}")
        col = board["columns"][0]["id"]
        self.api("POST", f"/api/boards/{bid}/members", {"user_id":uid,"role":"member"})
        card, _ = self.api("POST", f"/api/columns/{col}/cards", {"title":"Assigned", "assignee":"Legacy name", "assignee_ids":[uid,1]}, expected=201)
        cid = card["id"]
        detail, _ = self.api("GET", f"/api/cards/{cid}")
        self.assertEqual(sorted(detail["assignee_ids"]), [1,uid])
        self.assertEqual(detail["assignee"], "Legacy name")
        tasks, _ = self.api("GET", "/api/me/tasks", actor="member")
        self.assertEqual([x["id"] for x in tasks["cards"]], [cid])
        self.api("PATCH", f"/api/cards/{cid}", {"title":"Must roll back", "assignee_ids":[other]}, expected=400)
        self.assertEqual(self.api("GET", f"/api/cards/{cid}")[0]["title"], "Assigned")
        for ids in ([uid,uid],["1"],[-1]):
            self.api("PATCH", f"/api/cards/{cid}/assignees", {"user_ids":ids}, expected=400)
        self.api("DELETE", f"/api/boards/{bid}/members/{uid}")
        self.assertEqual(self.api("GET", "/api/me/tasks", actor="member")[0]["cards"], [])
        self.api("GET", f"/api/cards/{cid}/assignees", actor="member", expected=404)
        removed_copy, _ = self.api("POST", f"/api/cards/{cid}/duplicate", {}, expected=201)
        self.assertEqual(self.api("GET", f"/api/cards/{removed_copy['id']}")[0]["assignee_ids"], [1])
        self.assertEqual(sorted(self.api("GET", f"/api/cards/{cid}")[0]["assignee_ids"]), [1,uid])
        self.api("POST", f"/api/boards/{bid}/members", {"user_id":uid,"role":"member"})
        self.api("PATCH", f"/api/users/{uid}", {"active":False})
        self.api("PATCH", f"/api/cards/{cid}/assignees", {"user_ids":[uid]}, expected=400)
        inactive_copy, _ = self.api("POST", f"/api/cards/{cid}/duplicate", {}, expected=201)
        self.assertEqual(self.api("GET", f"/api/cards/{inactive_copy['id']}")[0]["assignee_ids"], [1])
        self.assertEqual(sorted(self.api("GET", f"/api/cards/{cid}")[0]["assignee_ids"]), [1,uid])

    def test_templates_and_saved_views_are_private(self):
        uid = self.add_user("member")
        self.login("member")
        board, _ = self.api("POST", "/api/boards", {"name":"Shared"}, expected=201)
        bid = board["id"]
        self.api("POST", f"/api/boards/{bid}/members", {"user_id":uid,"role":"member"})
        detail, _ = self.api("GET", f"/api/boards/{bid}")
        col = detail["columns"][0]["id"]
        card, _ = self.api("POST", f"/api/columns/{col}/cards", {"title":"Source"}, expected=201)
        template, _ = self.api("POST", "/api/templates/cards", {"card_id":card["id"],"name":"Private model"}, expected=201)
        view, _ = self.api("POST", f"/api/boards/{bid}/views", {"name":"Personal","filters":{}}, expected=201)
        self.assertEqual(self.api("GET", "/api/templates/cards", actor="member")[0]["templates"], [])
        self.api("POST", f"/api/templates/cards/{template['id']}/instantiate", {"column_id":col}, actor="member", expected=404)
        self.api("DELETE", f"/api/templates/cards/{template['id']}", actor="member", expected=404)
        self.assertEqual(self.api("GET", f"/api/boards/{bid}/views", actor="member")[0]["views"], [])
        self.api("PATCH", f"/api/views/{view['id']}", {"name":"Stolen"}, actor="member", expected=404)
        self.api("DELETE", f"/api/views/{view['id']}", actor="member", expected=404)

    def test_global_observer_can_manage_own_filters_without_writing_board(self):
        uid = self.add_user("viewer", "observer")
        self.login("viewer")
        self.api("POST", "/api/boards/1/members", {"user_id":uid,"role":"observer"})
        view, _ = self.api("POST", "/api/boards/1/views", {"name":"Read view","filters":{"priority":"high"}}, actor="viewer", expected=201)
        self.api("PATCH", f"/api/views/{view['id']}", {"name":"Renamed"}, actor="viewer")
        self.assertEqual(self.api("GET", "/api/boards/1/views", actor="viewer")[0]["views"][0]["name"], "Renamed")
        self.api("PATCH", "/api/cards/1", {"title":"Forbidden"}, actor="viewer", expected=403)
        self.api("POST", "/api/boards/2/views", {"name":"Private","filters":{}}, actor="viewer", expected=404)
        self.api("DELETE", f"/api/views/{view['id']}", actor="viewer")
        self.assertEqual(self.api("GET", "/api/boards/1/views", actor="viewer")[0]["views"], [])


if __name__ == "__main__":
    unittest.main()
