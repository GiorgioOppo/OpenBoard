#!/usr/bin/env python3
"""Localized initial lists use an explicit creation hint, never rewrite data."""
import json
import unittest

import test_auth


class OpenBoardLanguageDefaults(unittest.TestCase):
    # Share only the disposable authenticated server harness, not inherited tests.
    setUp = test_auth.OpenBoardAuth.setUp
    stop = test_auth.OpenBoardAuth.stop
    read_log = test_auth.OpenBoardAuth.read_log
    request = test_auth.OpenBoardAuth.request
    api = test_auth.OpenBoardAuth.api
    session = test_auth.OpenBoardAuth.session
    add_user = test_auth.OpenBoardAuth.add_user
    login = test_auth.OpenBoardAuth.login
    sql = test_auth.OpenBoardAuth.sql

    def persisted_state(self):
        return {
            table: self.sql(f"SELECT * FROM {table} ORDER BY 1")
            for table in ("boards", "columns", "board_members", "activity")
        }

    def test_initial_lists_in_each_supported_language_preserve_user_data(self):
        defaults = {
            "it": ["Da fare", "In corso", "Completato"],
            "en": ["To do", "In progress", "Done"],
            "fr": ["À faire", "En cours", "Terminé"],
            "es": ["Por hacer", "En curso", "Completado"],
            "de": ["Zu erledigen", "In Arbeit", "Erledigt"],
            "zh-CN": ["待办", "进行中", "已完成"],
            "ja": ["未着手", "進行中", "完了"],
        }
        previous = self.sql("SELECT id,title FROM columns ORDER BY id")
        for language, titles in defaults.items():
            with self.subTest(language=language):
                name = f"Release · 作業 · {language}"
                description = "Keep my content: Da fare · 进行中 · À faire"
                created, _ = self.api("POST", "/api/boards", {
                    "name": name, "description": description, "language": language,
                }, expected=201)
                result, _ = self.api("GET", f"/api/boards/{created['id']}")
                board = result.get("board", result)
                self.assertEqual(board["name"], name)
                self.assertEqual(board["description"], description)
                self.assertNotIn("language", board)
                self.assertEqual([column["title"] for column in board["columns"]], titles)
                self.assertEqual([column["position"] for column in board["columns"]], [0, 1, 2])
                self.assertTrue(all(not column["cards"] for column in board["columns"]))
        self.assertEqual(self.sql("SELECT id,title FROM columns ORDER BY id")[:len(previous)], previous)
        self.assertEqual(self.sql("PRAGMA user_version"), [(7,)])
        self.assertEqual(self.sql("PRAGMA foreign_key_check"), [])

    def test_omitted_hint_keeps_legacy_defaults_independent_of_accept_language(self):
        created, _ = self.api("POST", "/api/boards", {"name": "Legacy API"},
                              headers={"Accept-Language": "ja"}, expected=201)
        self.assertEqual(self.sql("SELECT title FROM columns WHERE board_id=? ORDER BY position", (created["id"],)),
                         [("Da fare",), ("In corso",), ("Completato",)])

    def test_invalid_types_and_unsupported_values_do_not_create_partial_boards(self):
        before = self.persisted_state()
        invalid = [None, False, True, 0, 1.5, [], {}, "", "EN", "zh", "zh-cn", "en-US", "en ", " en", "it\x00", "x" * 50]
        for language in invalid:
            with self.subTest(language=language):
                result, _ = self.api("POST", "/api/boards", {"name": "Must not exist", "language": language}, expected=400)
                self.assertEqual(result["error"], "Lingua della bacheca non valida.")
                self.assertEqual(self.persisted_state(), before)

    def test_invalid_unicode_duplicate_keys_and_malformed_json_are_atomic(self):
        before = self.persisted_state()
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}",
                   "Cookie": self.sessions["admin"]["cookie"], "X-CSRF-Token": self.sessions["admin"]["csrf"]}
        payloads = [
            b'{"name":"Must not exist","language":"\\ud800"}',
            b'{"name":"Must not exist","language":"en","language":"ja"}',
            b'{"name":"Must not exist","language":',
            b'{"name":"Must not exist","language":"\xff"}',
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                status, _, body = self.request("POST", "/api/boards", payload, headers)
                self.assertEqual(status, 400, body)
                self.assertTrue(json.loads(body)["error"])
                self.assertEqual(self.persisted_state(), before)

    def test_patch_rejects_any_language_hint_without_changing_board_or_lists(self):
        created, _ = self.api("POST", "/api/boards", {"name": "Original", "language": "fr"}, expected=201)
        before = self.persisted_state()
        for language in ("en", "it", None, False, "unknown"):
            with self.subTest(language=language):
                result, _ = self.api("PATCH", f"/api/boards/{created['id']}",
                                     {"name": "Must not change", "language": language}, expected=400)
                self.assertEqual(result["error"], "Il campo language è consentito solo alla creazione della bacheca.")
                self.assertEqual(self.persisted_state(), before)
        self.api("PATCH", f"/api/boards/{created['id']}", {"name": "Renamed"})
        self.assertEqual(self.sql("SELECT title FROM columns WHERE board_id=? ORDER BY position", (created["id"],)),
                         [("À faire",), ("En cours",), ("Terminé",)])

    def test_observer_cannot_create_a_board_with_a_language_hint(self):
        self.add_user("viewer", "observer")
        self.login("viewer")
        before = self.persisted_state()
        self.api("POST", "/api/boards", {"name": "Forbidden", "language": "en"}, actor="viewer", expected=403)
        self.assertEqual(self.persisted_state(), before)


if __name__ == "__main__":
    unittest.main()
