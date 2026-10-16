#!/usr/bin/env python3
"""Authenticated internal forms: typed snapshots, ACL and atomic card conversion."""
import csv
import io
import json
import http.client
import subprocess
import sqlite3
import time
import unittest

import test_auth as helpers


class OpenBoardIntake(unittest.TestCase):
    setUp = helpers.OpenBoardAuth.setUp
    stop = helpers.OpenBoardAuth.stop
    read_log = helpers.OpenBoardAuth.read_log
    request = helpers.OpenBoardAuth.request
    api = helpers.OpenBoardAuth.api
    session = helpers.OpenBoardAuth.session
    add_user = helpers.OpenBoardAuth.add_user
    login = helpers.OpenBoardAuth.login
    def sql(self, query, parameters=()):
        connection = sqlite3.connect(self.db)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            with connection:
                return connection.execute(query, parameters).fetchall()
        finally:
            connection.close()

    def member(self, username, role="member", board=1, global_role=None):
        uid = self.add_user(username, global_role or role)
        self.api("POST", f"/api/boards/{board}/members", {"user_id": uid, "role": role})
        self.login(username)
        return uid

    def form(self, publish=False, **values):
        form, _ = self.api("POST", "/api/boards/1/intake/forms", {
            "name": "Richieste del team", "description": "Raccogliamo le esigenze", "column_id": 1, **values,
        }, expected=201)
        if publish:
            form, _ = self.api("POST", f"/api/intake/forms/{form['id']}/publish", {}, headers={"If-Match": str(form["version"])})
        return form

    def field(self, form, key="details", kind="text", **values):
        field, _ = self.api("POST", f"/api/intake/forms/{form['id']}/fields", {
            "key": key, "name": key.title(), "type": kind, **values,
        }, expected=201)
        return field

    def submit(self, form, answers=None, actor="admin", title="Richiesta di un nuovo servizio", **kwargs):
        item, _ = self.api("POST", f"/api/intake/forms/{form['id']}/requests", {
            "title": title, "answers": answers or {},
        }, actor=actor, expected=kwargs.pop("expected", 201), **kwargs)
        return item

    def test_forms_lifecycle_lists_versions_target_validation_and_manager_acl(self):
        self.member("alice")
        self.member("manager", "admin", global_role="member")
        form = self.form()
        self.assertEqual((form["published"], form["version"], form["fields"]), (False, 1, []))
        self.assertTrue(form["can_manage"])
        path = f"/api/intake/forms/{form['id']}"
        listed, _ = self.api("GET", "/api/boards/1/intake/forms")
        self.assertEqual(listed, {"items": [form], "next_cursor": None})
        member, _ = self.api("GET", path, actor="alice")
        self.assertFalse(member["can_manage"])
        self.api("POST", "/api/boards/1/intake/forms", {"name": "No", "column_id": 1}, actor="alice", expected=403)
        self.api("PATCH", path, {"name": "No"}, actor="alice", expected=403)
        self.api("GET", path + "?include_deleted=1", actor="alice", expected=403)
        self.api("PATCH", path, {"column_id": 999}, expected=400)
        other_column = self.sql("SELECT id FROM columns WHERE board_id<>1 LIMIT 1")[0][0]
        self.api("PATCH", path, {"column_id": other_column}, expected=400)
        edited, _ = self.api("PATCH", path, {"name": "Nuovo nome", "description": "Descrizione", "column_id": 2}, actor="manager", headers={"If-Match": '"1"'})
        self.assertEqual((edited["version"], edited["column_id"]), (2, 2))
        self.api("POST", path + "/publish", {}, headers={"If-Match": "1"}, expected=412)
        published, _ = self.api("POST", path + "/publish", {}, headers={"If-Match": "2"})
        self.assertTrue(published["published"])
        self.api("POST", path + "/publish", {}, expected=409)
        paused, _ = self.api("POST", path + "/pause", {}, headers={"If-Match": "3"})
        self.assertFalse(paused["published"])
        deleted, _ = self.api("DELETE", path, headers={"If-Match": "4"})
        self.assertTrue(deleted["deleted_at"])
        self.api("GET", path, expected=404)
        self.assertEqual(self.api("GET", "/api/boards/1/intake/forms")[0]["items"], [])
        self.assertEqual(self.api("GET", "/api/boards/1/intake/forms?include_deleted=1")[0]["items"], [deleted])
        restored, _ = self.api("POST", path + "/restore", {}, headers={"If-Match": "5"})
        self.assertEqual((restored["version"], restored["deleted_at"]), (6, None))
        self.api("POST", path + "/restore", {}, expected=409)

    def test_typed_fields_edit_reorder_soft_delete_restore_and_exact_permutation(self):
        form = self.form()
        text = self.field(form, required=True)
        select = self.field(form, "area", "select", options=["Prodotto", "Supporto"])
        number = self.field(form, "cost", "number")
        boolean = self.field(form, "urgent", "boolean")
        date = self.field(form, "wanted", "date")
        path = f"/api/intake/forms/{form['id']}"
        current, _ = self.api("GET", path)
        self.assertEqual(len(current["fields"]), 5)
        self.assertEqual(current["fields"][0]["required"], True)
        self.api("POST", path + "/fields/reorder", {"field_ids": [text["id"]]}, expected=400)
        self.api("POST", path + "/fields/reorder", {"field_ids": [text["id"]] * 5}, expected=400)
        self.api("POST", path + "/fields/reorder", {"field_ids": [True, 2, 3, 4, 5]}, expected=400)
        ordered = [date["id"], boolean["id"], number["id"], select["id"], text["id"]]
        reordered, _ = self.api("POST", path + "/fields/reorder", {"field_ids": ordered}, headers={"If-Match": str(current["version"])})
        self.assertEqual([f["id"] for f in reordered["fields"]], ordered)
        self.api("PATCH", f"/api/intake/fields/{select['id']}", {"name": "Sezione"}, headers={"If-Match": "1"}, expected=412)
        edited, _ = self.api("PATCH", f"/api/intake/fields/{select['id']}", {"name": "Sezione", "options": ["Team", "Azienda"], "required": True}, headers={"If-Match": "2"})
        self.assertEqual((edited["version"], edited["options"]), (3, ["Team", "Azienda"]))
        deleted, _ = self.api("DELETE", f"/api/intake/fields/{text['id']}", headers={"If-Match": "2"})
        self.assertTrue(deleted["deleted_at"])
        self.assertEqual(len(self.api("GET", path)[0]["fields"]), 4)
        self.assertEqual(len(self.api("GET", path + "?include_deleted=1")[0]["fields"]), 5)
        restored, _ = self.api("POST", f"/api/intake/fields/{text['id']}/restore", {}, headers={"If-Match": "3"})
        self.assertIsNone(restored["deleted_at"])
        self.assertEqual(restored["version"], 4)

    def test_strict_form_and_field_validation_keys_options_and_field_quota(self):
        for values in ({"name": " "}, {"name": "x" * 201}, {"column_id": True}, {"description": None}, {"extra": 1}, {"name,,description":1}, {"":1}):
            self.api("POST", "/api/boards/1/intake/forms", {"name": "Valido", "column_id": 1, **values}, expected=400)
        form = self.form()
        path = f"/api/intake/forms/{form['id']}/fields"
        invalid = [
            {"key": "__proto__"}, {"key": "constructor"}, {"key": "prototype"}, {"key": "$cost"}, {"key": "Upper"},
            {"key": "a.b"}, {"key": "1bad"}, {"type": "textarea"}, {"required": 1}, {"name": " "}, {"unknown": "x"},
            {"type": "select", "options": []}, {"type": "select", "options": ["A", "A"]},
            {"type": "select", "options": [True]}, {"type": "select", "options": [" "]},
            {"options": ["no"]}, {"options": {}},
        ]
        for values in invalid:
            self.api("POST", path, {"key": "field", "name": "Campo", "type": "text", **values}, expected=400)
        first = self.field(form, "field0")
        for n in range(1, 20):
            self.field(form, f"field{n}")
        self.api("POST", path, {"key": "extra", "name": "Extra", "type": "text"}, expected=409)
        self.api("DELETE", f"/api/intake/fields/{first['id']}")
        self.field(form, "extra")
        self.api("POST", f"/api/intake/fields/{first['id']}/restore", {}, expected=409)
        self.api("POST", path, {"key": "field0", "name": "Duplicato", "type": "text"}, expected=409)

    def test_typed_answers_real_dates_required_false_zero_unknown_duplicate_keys_and_bounds(self):
        form = self.form()
        self.field(form, "details", required=True)
        self.field(form, "amount", "number", required=True)
        self.field(form, "urgent", "boolean", required=True)
        self.field(form, "date", "date", required=True)
        self.field(form, "area", "select", required=True, options=["Team", "Azienda"])
        self.api("POST", f"/api/intake/forms/{form['id']}/publish", {})
        valid = {"details": "Testo con <script> e $date, €", "amount": 0, "urgent": False, "date": "2000-02-29", "area": "Team"}
        item = self.submit(form, valid)
        self.assertEqual(item["answers"], valid)
        self.assertIs(item["answers"]["urgent"], False)
        self.assertEqual(item["answers"]["amount"], 0)
        invalid = [
            {"amount": True}, {"urgent": 0}, {"amount": "0"}, {"date": "1900-02-29"}, {"date": "2026-02-29"},
            {"date": "2026-13-01"}, {"date": "2026-04-31"}, {"date": ""}, {"area": "Other"},
            {"details": " "}, {"details": None}, {"details": {"$numberInt": "1"}}, {"details": "x" * 8001},
            {"unknown": "x"}, {"__proto__": "x"}, {"amount": float("inf")},
        ]
        for change in invalid:
            self.submit(form, {**valid, **change}, expected=400)
        for removed in valid:
            missing = {k: v for k, v in valid.items() if k != removed}
            self.submit(form, missing, expected=400)
        self.submit(form, valid, title=" ", expected=400)
        self.submit(form, valid, title="x" * 301, expected=400)
        duplicate = '{"title":"Duplicate","answers":{"details":"a","details":"b","amount":0,"urgent":false,"date":"2000-02-29","area":"Team"}}'
        status, _, _ = self.request("POST", f"/api/intake/forms/{form['id']}/requests", duplicate, {
            "Content-Type": "application/json", "Cookie": self.sessions["admin"]["cookie"], "X-CSRF-Token": self.sessions["admin"]["csrf"],
            "Origin": f"http://127.0.0.1:{self.port}",
        })
        self.assertEqual(status, 400)
        self.assertEqual(self.sql("SELECT count(*) FROM intake_requests"), [(1,)])

    def test_escaped_unpaired_surrogates_rejected_before_ack_or_persistence(self):
        form = self.form(publish=True)
        self.field(form, "text")
        headers={"Content-Type":"application/json", "Cookie":self.sessions["admin"]["cookie"], "X-CSRF-Token":self.sessions["admin"]["csrf"], "Origin":f"http://127.0.0.1:{self.port}"}
        for escape in ("\\ud800", "\\udfff", "\\u0000"):
            for path, body in (
                (f"/api/intake/forms/{form['id']}/requests", '{"title":"Unicode","answers":{"text":"' + escape + '"}}'),
                (f"/api/intake/forms/{form['id']}/fields", '{"key":"choice","name":"Scelta","type":"select","options":["' + escape + '"]}'),
            ):
                status, _, _ = self.request("POST", path, body, headers)
                self.assertEqual(status,400,(path,body))
        self.assertEqual(self.sql("SELECT count(*) FROM intake_requests"),[(0,)])
        self.assertEqual(self.sql("SELECT count(*) FROM intake_fields"),[(1,)])
        valid_pair = '{"title":"Unicode","answers":{"text":"\\ud83d\\ude80"}}'
        status, _, data = self.request("POST",f"/api/intake/forms/{form['id']}/requests",valid_pair,headers)
        self.assertEqual(status,201)
        self.assertEqual(json.loads(data)["answers"]["text"],"🚀")

    def test_observer_personal_submission_edit_notes_csrf_and_current_membership_revocation(self):
        uid = self.member("observer", "observer")
        self.member("reader", "observer", global_role="member")
        form = self.form(publish=True)
        item = self.submit(form, actor="observer")
        path = f"/api/intake/requests/{item['id']}"
        self.assertTrue(item["can_edit"])
        self.assertFalse(item["can_triage"])
        edited, _ = self.api("PATCH", path, {"title": "Esigenza aggiornata"}, actor="observer", headers={"If-Match": "1"})
        self.assertEqual(edited["version"], 2)
        self.api("PATCH", path, {"title": "Obsoleto"}, actor="observer", headers={"If-Match": "1"}, expected=412)
        self.api("PATCH", path, {"title": "No"}, expected=403)
        self.api("POST", path + "/state", {"state": "accepted"}, actor="observer", expected=403)
        self.api("POST", path + "/convert", {}, actor="observer", expected=403)
        self.api("POST", path + "/notes", {"body": "Allegare requisiti"}, actor="observer", headers={"X-CSRF-Token": ""}, expected=403)
        noted, _ = self.api("POST", path + "/notes", {"body": "<b>Requisiti</b> e $json"}, actor="observer", headers={"If-Match": "2"}, expected=201)
        self.assertEqual(noted["notes"][0]["body"], "<b>Requisiti</b> e $json")
        reader_detail, _ = self.api("GET", path, actor="reader")
        self.assertFalse(reader_detail["can_triage"])
        self.api("POST", path + "/state", {"state": "accepted"}, actor="reader", expected=403)
        self.api("POST", path + "/notes", {"body": "No"}, actor="reader", expected=403)
        notes, _ = self.api("GET", path + "/notes", actor="reader")
        self.assertEqual(notes["items"], noted["notes"])
        mine, _ = self.api("GET", "/api/me/intake/requests", actor="observer")
        self.assertEqual([r["id"] for r in mine["items"]], [item["id"]])
        self.assertEqual(mine["items"][0]["notes_count"],1)
        self.assertNotIn("notes",mine["items"][0])
        self.api("GET", path, actor=None, expected=401)
        self.api("DELETE", f"/api/boards/1/members/{uid}")
        self.api("GET", path, actor="observer", expected=404)
        self.api("PATCH", path, {"title": "No"}, actor="observer", expected=404)
        self.api("POST", f"/api/intake/forms/{form['id']}/requests", {"title": "No", "answers": {}}, actor="observer", expected=404)
        mine, _ = self.api("GET", "/api/me/intake/requests", actor="observer")
        self.assertEqual(mine["items"], [])

    def test_snapshot_evolution_keeps_old_typed_answers_and_pause_blocks_only_new_submits(self):
        self.member("alice")
        form = self.form()
        select = self.field(form, "area", "select", required=True, options=["Vecchia", "Legacy"])
        self.api("POST", f"/api/intake/forms/{form['id']}/publish", {})
        original = self.submit(form, {"area": "Vecchia"}, actor="alice")
        path = f"/api/intake/requests/{original['id']}"
        self.assertFalse(original["form_changed"])
        self.api("PATCH", f"/api/intake/fields/{select['id']}", {"name": "Area aggiornata", "type": "number", "options": []})
        self.submit(form, {"area": 0}, actor="alice", headers={"If-Match": str(original["form_version"])}, expected=412)
        self.submit(form, {"area": 0}, actor="alice", headers={"If-Match": "bad"}, expected=400)
        evolved, _ = self.api("GET", path, actor="alice")
        self.assertTrue(evolved["form_changed"])
        self.assertEqual(evolved["schema_snapshot"], original["schema_snapshot"])
        changed, _ = self.api("PATCH", path, {"answers": {"area": "Legacy"}}, actor="alice")
        self.assertEqual(changed["answers"], {"area": "Legacy"})
        self.api("PATCH", path, {"answers": {"area": 12}}, actor="alice", expected=400)
        self.submit(form, {"area": "Vecchia"}, actor="alice", expected=400)
        current = self.submit(form, {"area": 0}, actor="alice")
        self.assertEqual(current["schema_snapshot"][0]["type"], "number")
        self.api("DELETE", f"/api/intake/fields/{select['id']}")
        self.assertEqual(self.api("GET", path)[0]["answers"], {"area": "Legacy"})
        self.api("POST", f"/api/intake/forms/{form['id']}/pause", {})
        self.submit(form, actor="alice", expected=409)
        updated, _ = self.api("PATCH", path, {"title": "Storica aggiornata"}, actor="alice")
        self.assertEqual(updated["title"], "Storica aggiornata")

    def test_triage_convert_idempotency_and_atomic_failure_before_retry(self):
        self.member("alice")
        form = self.form(publish=True)
        self.field(form, "count", "number")
        self.field(form, "urgent", "boolean")
        self.field(form, "text", "text")
        item = self.submit(form, {"count": 0, "urgent": False, "text": "<script>alert(1)</script>"}, actor="alice", title="=Titolo originale")
        path = f"/api/intake/requests/{item['id']}"
        self.api("POST", path + "/convert", {}, expected=409)
        reviewed, _ = self.api("POST", path + "/state", {"state": "in_review"}, headers={"If-Match": "1"})
        self.assertEqual(reviewed["state"], "in_review")
        accepted, _ = self.api("POST", path + "/state", {"state": "accepted"}, headers={"If-Match": "2"})
        self.api("PATCH", path, {"title": "No"}, actor="alice", expected=409)
        before = self.sql("SELECT count(*) FROM cards")[0][0]
        self.sql("CREATE TRIGGER fail_intake_conversion BEFORE UPDATE OF converted_card_id ON intake_requests WHEN NEW.converted_card_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test failure'); END")
        self.api("POST", path + "/convert", {}, headers={"If-Match": str(accepted["version"])}, expected=503)
        self.assertEqual(self.sql("SELECT count(*) FROM cards")[0][0], before)
        unchanged, _ = self.api("GET", path)
        self.assertEqual(unchanged, accepted)
        self.sql("DROP TRIGGER fail_intake_conversion")
        converted, _ = self.api("POST", path + "/convert", {}, headers={"If-Match": str(accepted["version"]), "Idempotency-Key": "intake-convert-1"})
        self.assertTrue(converted["converted_card_id"])
        self.assertTrue(converted["converted_card_available"])
        card, _ = self.api("GET", f"/api/cards/{converted['converted_card_id']}")
        self.assertEqual(card["title"], "=Titolo originale")
        self.assertIn("Count: 0", card["description"])
        self.assertIn("Urgent: false", card["description"])
        self.assertIn("<script>alert(1)</script>", card["description"])
        replay, _ = self.api("POST", path + "/convert", {}, headers={"If-Match": str(accepted["version"]), "Idempotency-Key": "intake-convert-1"})
        self.assertEqual(replay, converted)
        self.assertEqual(self.sql("SELECT count(*) FROM cards")[0][0], before + 1)
        self.api("POST", path + "/convert", {}, expected=409)
        self.api("POST", path + "/state", {"state": "in_review"}, expected=409)
        self.api("PATCH", path, {"answers": {}}, actor="alice", expected=409)

    def test_conversion_obeys_wip_live_target_and_explicit_long_description_override(self):
        form = self.form(publish=True)
        self.field(form, "text")
        self.field(form, "other")
        item = self.submit(form, {"text": "a" * 6000, "other": "b" * 6000})
        path = f"/api/intake/requests/{item['id']}"
        self.api("POST", path + "/state", {"state": "accepted"})
        self.api("POST", path + "/convert", {}, expected=413)
        count = self.sql("SELECT count(*) FROM cards WHERE column_id=1 AND deleted_at IS NULL AND archived=0 AND completed=0")[0][0]
        self.api("PATCH", "/api/columns/1", {"wip_limit": count})
        self.api("POST", path + "/convert", {"description": "Riassunto esplicito; tutte le risposte restano nella richiesta."}, expected=409)
        self.assertIsNone(self.api("GET", path)[0]["converted_card_id"])
        self.api("PATCH", "/api/columns/1", {"wip_limit": 0})
        converted, _ = self.api("POST", path + "/convert", {"description": "Riassunto esplicito"})
        self.assertEqual(converted["answers"], item["answers"])
        card, _ = self.api("GET", f"/api/cards/{converted['converted_card_id']}")
        self.assertEqual(card["description"], "Riassunto esplicito")
        another = self.submit(form, {"text": "x"})
        another_path = f"/api/intake/requests/{another['id']}"
        self.api("POST", another_path + "/state", {"state": "accepted"})
        self.api("DELETE", "/api/columns/1")
        self.api("POST", another_path + "/convert", {}, expected=409)

    def test_hard_removed_target_preserves_form_and_request_then_manager_can_retarget(self):
        self.member("alice")
        form = self.form(publish=True)
        item = self.submit(form, actor="alice")
        path = f"/api/intake/requests/{item['id']}"
        self.api("POST", path + "/state", {"state":"accepted"})
        self.sql("DELETE FROM columns WHERE id=1")
        current, _ = self.api("GET", f"/api/intake/forms/{form['id']}", actor="alice")
        self.assertIsNone(current["column_id"])
        self.assertEqual(current["version"], form["version"]+1)
        target_history, _ = self.api("GET", f"/api/intake/forms/{form['id']}/history?limit=1")
        self.assertEqual(target_history["items"][0]["action"], "target_column_removed")
        historical, _ = self.api("GET", path, actor="alice")
        self.assertEqual(historical["answers"], item["answers"])
        self.assertTrue(historical["form_changed"])
        self.api("POST", path + "/convert", {}, expected=409)
        self.api("PATCH", f"/api/intake/forms/{form['id']}", {"column_id":2}, actor="alice", expected=403)
        self.api("POST", f"/api/intake/forms/{form['id']}/pause", {})
        self.api("POST", f"/api/intake/forms/{form['id']}/publish", {}, expected=409)
        retargeted, _ = self.api("PATCH", f"/api/intake/forms/{form['id']}", {"column_id":2})
        self.assertEqual(retargeted["column_id"], 2)
        self.api("POST", f"/api/intake/forms/{form['id']}/publish", {})
        converted, _ = self.api("POST", path + "/convert", {})
        card, _ = self.api("GET", f"/api/cards/{converted['converted_card_id']}")
        self.assertEqual(card["column_id"], 2)
        converted_id = converted["converted_card_id"]
        self.sql("DELETE FROM columns WHERE id=2")
        retained, _ = self.api("GET", path)
        self.assertEqual(retained["converted_card_id"], converted_id)
        self.assertFalse(retained["converted_card_available"])
        self.api("PATCH", f"/api/intake/forms/{form['id']}", {"column_id":3})
        self.api("POST", path + "/convert", {}, expected=409)
        self.assertEqual(self.api("GET","/api/boards/1/intake/stats")[0]["converted"],1)
        self.assertEqual(self.sql("PRAGMA foreign_key_check"), [])

    def test_inbox_personal_pages_soft_delete_restore_audit_stats_and_live_ancestors(self):
        self.member("alice")
        self.member("outsider", board=2)
        form = self.form(publish=True)
        first = self.submit(form, actor="alice")
        second = self.submit(form)
        third = self.submit(form, actor="alice")
        path = f"/api/intake/requests/{third['id']}"
        rejected, _ = self.api("POST", path + "/state", {"state": "rejected"})
        self.api("PATCH", path, {"title": "No"}, actor="alice", expected=409)
        reopened, _ = self.api("POST", path + "/state", {"state": "new"})
        self.assertTrue(reopened["can_edit"] is False)  # admin is not the author
        inbox, _ = self.api("GET", "/api/boards/1/intake/requests?limit=2")
        self.assertEqual([i["id"] for i in inbox["items"]], [third["id"], second["id"]])
        self.assertEqual(inbox["next_cursor"], second["id"])
        tail, _ = self.api("GET", f"/api/boards/1/intake/requests?before={inbox['next_cursor']}&limit=2")
        self.assertEqual([i["id"] for i in tail["items"]], [first["id"]])
        mine, _ = self.api("GET", "/api/me/intake/requests", actor="alice")
        self.assertEqual([i["id"] for i in mine["items"]], [third["id"], first["id"]])
        search, _ = self.api("GET", "/api/boards/1/intake/requests?q=Alice")
        self.assertEqual([i["id"] for i in search["items"]], [third["id"], first["id"]])
        self.assertEqual(self.api("GET", "/api/boards/1/intake/requests?q=%25")[0]["items"], [])
        self.api("GET", "/api/boards/1/intake/requests?q=" + "x"*201, expected=400)
        deleted, _ = self.api("DELETE", path, actor="alice", headers={"If-Match": "3"})
        self.assertTrue(deleted["deleted_at"])
        self.api("GET", path, expected=404)
        trashed_history, _ = self.api("GET", path + "/history?limit=1", actor="alice")
        self.assertEqual(trashed_history["items"][0]["action"], "request_deleted")
        self.assertEqual(self.api("GET", path + "?include_deleted=1", actor="alice")[0]["id"], third["id"])
        restored, _ = self.api("POST", path + "/restore", {}, actor="alice", headers={"If-Match": "4"})
        self.assertEqual(restored["version"], 5)
        history, _ = self.api("GET", path + "/history?limit=2")
        self.assertEqual([e["action"] for e in history["items"]], ["request_restored", "request_deleted"])
        older, _ = self.api("GET", path + f"/history?before={history['next_cursor']}")
        self.assertEqual([e["action"] for e in older["items"]], ["request_state_changed", "request_state_changed", "request_submitted"])
        stats, _ = self.api("GET", "/api/boards/1/intake/stats")
        self.assertEqual(stats, {"total": 3, "new": 3, "in_review": 0, "accepted": 0, "rejected": 0, "converted": 0})
        for route in (path, f"/api/intake/forms/{form['id']}", "/api/boards/1/intake/requests", "/api/boards/1/intake/stats", "/api/boards/1/intake/export"):
            self.api("GET", route, actor="outsider", expected=404)
        for query in ("limit=101", "before=0", "include_deleted=yes", "state=bad"):
            self.api("GET", "/api/boards/1/intake/requests?" + query, expected=400)
        self.api("DELETE", f"/api/intake/forms/{form['id']}")
        self.api("GET", path, expected=404)
        self.assertEqual(self.api("GET", "/api/me/intake/requests", actor="alice")[0]["items"], [])
        self.api("POST", f"/api/intake/forms/{form['id']}/restore", {})
        self.api("DELETE", "/api/boards/1")
        self.api("GET", path, expected=404)

    def test_safe_csv_preserves_typed_json_and_rejects_excess_rows_without_truncation(self):
        form = self.form(publish=True, name="@Formula")
        self.field(form, "amount", "number")
        self.field(form, "urgent", "boolean")
        self.field(form, "details", "text")
        answers = {"amount": 0, "urgent": False, "details": 'Virgolette " e newline\n=1+1, $literal'}
        self.submit(form, answers, title="  =HYPERLINK(\"x\")")
        headers = {"Cookie": self.sessions["admin"]["cookie"]}
        status, response_headers, body = self.request("GET", "/api/boards/1/intake/export", headers=headers)
        self.assertEqual(status, 200)
        self.assertIn("text/csv", response_headers["content-type"])
        self.assertIn("attachment", response_headers["content-disposition"])
        rows = list(csv.DictReader(io.StringIO(body.decode())))
        self.assertEqual(rows[0]["form"], "'@Formula")
        self.assertEqual(rows[0]["title"], "'  =HYPERLINK(\"x\")")
        self.assertEqual(json.loads(rows[0]["answers_json"]), answers)
        self.assertEqual(json.loads(rows[0]["schema_snapshot_json"])[0]["key"], "amount")
        large_answers = json.dumps({"details": "x" * 45000})
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50) INSERT INTO intake_requests(form_id,board_id,author_id,title,answers,schema_snapshot,form_version) SELECT ?,1,1,'Size quota',?,'[]',1 FROM n", (form["id"], large_answers))
        self.api("GET", "/api/boards/1/intake/export", expected=413)
        self.sql("DELETE FROM intake_requests WHERE title='Size quota'")
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO intake_requests(form_id,board_id,author_id,title,answers,schema_snapshot,form_version) SELECT ?,1,1,'Synthetic','{}','[]',1 FROM n", (form["id"],))
        self.api("GET", "/api/boards/1/intake/export", expected=413)

    def test_intake_requires_real_accounts_even_in_explicit_development_no_auth_mode(self):
        form = self.form(publish=True)
        item = self.submit(form)
        self.stop()
        self.process = subprocess.Popen([str(helpers.BINARY), "--port", str(self.port), "--db", str(self.db), "--no-auth", "--quiet"], cwd=helpers.ROOT, stdout=self.log, stderr=subprocess.STDOUT)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            try:
                if self.request("GET","/api/health")[0]==200: break
            except (OSError,http.client.HTTPException): pass
            time.sleep(.025)
        else: self.fail("No-auth test server did not start: "+self.read_log())
        for method,path,payload in (
            ("GET","/api/boards/1/intake/forms",None),
            ("POST","/api/boards/1/intake/forms",{"name":"No", "column_id":1}),
            ("GET",f"/api/intake/forms/{form['id']}",None),
            ("POST",f"/api/intake/forms/{form['id']}/requests",{"title":"No","answers":{}}),
            ("GET",f"/api/intake/requests/{item['id']}",None),
            ("GET","/api/me/intake/requests",None),
            ("GET","/api/boards/1/intake/export",None),
        ):
            self.api(method,path,payload,actor=None,expected=403)

    def test_request_and_note_quotas_reject_without_partial_writes(self):
        form = self.form(publish=True)
        item = self.submit(form)
        path = f"/api/intake/requests/{item['id']}"
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO intake_notes(request_id,author_id,body) SELECT ?,1,'Quota note' FROM n", (item["id"],))
        for route in ("/api/boards/1/intake/requests", "/api/me/intake/requests"):
            listed, _ = self.api("GET", route)
            self.assertEqual(listed["items"][0]["notes_count"], 1000)
            self.assertNotIn("notes", listed["items"][0])
            self.assertLess(len(json.dumps(listed).encode()), 2048)
        detailed, _ = self.api("GET", path)
        self.assertEqual(detailed["notes_count"], 1000)
        self.assertEqual(len(detailed["notes"]), 1000)
        notes, _ = self.api("GET", path + "/notes")
        self.assertEqual(len(notes["items"]), 1000)
        self.api("POST", path + "/notes", {"body": "Oltre quota"}, expected=409)
        self.assertEqual(self.sql("SELECT version FROM intake_requests WHERE id=?", (item["id"],)), [(1,)])
        self.sql("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO intake_requests(form_id,board_id,author_id,title,answers,schema_snapshot,form_version) SELECT ?,1,1,'Synthetic','{}','[]',1 FROM n", (form["id"],))
        self.submit(form, expected=409)
        self.assertEqual(self.sql("SELECT count(*) FROM intake_requests"), [(10000,)])


if __name__ == "__main__":
    unittest.main()
