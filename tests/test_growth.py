"""Authenticated regressions for storage growth and review content safety."""
import time
import unittest
from urllib.parse import quote

import test_auth as auth_helpers


class GrowthTests(unittest.TestCase):
    setUp = auth_helpers.OpenBoardAuth.setUp
    stop = auth_helpers.OpenBoardAuth.stop
    read_log = auth_helpers.OpenBoardAuth.read_log
    request = auth_helpers.OpenBoardAuth.request
    api = auth_helpers.OpenBoardAuth.api
    session = auth_helpers.OpenBoardAuth.session
    add_user = auth_helpers.OpenBoardAuth.add_user
    login = auth_helpers.OpenBoardAuth.login
    sql = auth_helpers.OpenBoardAuth.sql

    def test_session_reads_coalesce_without_extending_absolute_lifetime(self):
        before = self.sql("SELECT last_seen,expires_at FROM sessions")
        for _ in range(3):
            self.api("GET", "/api/boards")
        self.assertEqual(self.sql("SELECT last_seen,expires_at FROM sessions"), before)
        stale = int(time.time()) - 61
        self.sql("UPDATE sessions SET last_seen=?", (stale,))
        self.api("GET", "/api/boards")
        seen, expiry = self.sql("SELECT last_seen,expires_at FROM sessions")[0]
        self.assertGreater(seen, stale)
        self.assertEqual(expiry, before[0][1])
        self.sql("UPDATE sessions SET last_seen=?", (int(time.time()) - 1801,))
        self.api("GET", "/api/boards", expected=401)

    def approved_review(self):
        reviewer = self.add_user("reviewer")
        self.api("POST", "/api/boards/1/members", {"user_id": reviewer, "role": "member"})
        self.login("reviewer")
        review, _ = self.api("POST", "/api/cards/1/reviews",
                             {"title": "Content approval", "reviewer_ids": [reviewer]}, expected=201)
        voted, _ = self.api("POST", f"/api/reviews/{review['id']}/vote",
                            {"decision": "approved"}, actor="reviewer")
        self.assertEqual(voted["status"], "approved")
        return voted

    def test_material_card_change_invalidates_approval_atomically(self):
        review = self.approved_review()
        self.api("PATCH", "/api/cards/1", {"description": "New content after approval"})
        after, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual(after["status"], "pending")
        self.assertEqual(after["approved_count"], 0)
        self.assertEqual(after["version"], review["version"] + 1)
        self.assertEqual(self.sql("SELECT action FROM review_events WHERE review_id=? ORDER BY id DESC LIMIT 1",
                                  (review['id'],)), [("review_content_changed",)])
        self.api("POST", f"/api/reviews/{review['id']}/vote", {"decision": "approved"},
                 actor="reviewer", headers={"If-Match": str(review["version"])}, expected=412)

    def test_ordering_and_identical_content_preserve_approval(self):
        review = self.approved_review()
        card, _ = self.api("GET", "/api/cards/1")
        self.api("PATCH", "/api/cards/1", {"description": card["description"], "position": 1})
        after, _ = self.api("GET", f"/api/reviews/{review['id']}")
        self.assertEqual(after["status"], "approved")
        self.assertEqual(after["version"], review["version"])

    def test_review_invalidation_rolls_back_when_a_write_fails(self):
        review = self.approved_review()
        card, _ = self.api("GET", "/api/cards/1")
        self.sql("CREATE TRIGGER reject_test_activity BEFORE INSERT ON activity "
                 "BEGIN SELECT RAISE(ABORT,'test failure'); END")
        self.api("PATCH", "/api/cards/1", {"description": "Must not commit"}, expected=503)
        self.sql("DROP TRIGGER reject_test_activity")
        after, _ = self.api("GET", f"/api/reviews/{review['id']}")
        current, _ = self.api("GET", "/api/cards/1")
        self.assertEqual(after["status"], "approved")
        self.assertEqual(after["version"], review["version"])
        self.assertEqual(current["description"], card["description"])

    def test_search_cursors_are_stable_and_apply_permissions_before_paging(self):
        user = self.add_user("searcher")
        self.api("POST", "/api/boards/1/members", {"user_id": user, "role": "observer"})
        self.login("searcher")
        term = "cursor needle 日本"
        wanted = []
        for index in range(5):
            card, _ = self.api("POST", "/api/columns/1/cards", {"title": f"{term} {index}"}, expected=201)
            wanted.append(card["id"])
        hidden, _ = self.api("POST", "/api/boards", {"name": "Private"}, expected=201)
        board, _ = self.api("GET", f"/api/boards/{hidden['id']}")
        self.api("POST", f"/api/columns/{board['columns'][0]['id']}/cards", {"title": term}, expected=201)
        base = "/api/search?q=" + quote(term) + "&limit=2"
        first, _ = self.api("GET", base, actor="searcher")
        self.assertEqual([item["id"] for item in first["cards"]], list(reversed(wanted[-2:])))
        self.assertEqual(first["next_cursor"], wanted[-2])
        # A newer insertion must not shift or duplicate the following page.
        self.api("POST", "/api/columns/1/cards", {"title": term}, expected=201)
        seen = [item["id"] for item in first["cards"]]
        cursor = first["next_cursor"]
        while cursor:
            page, _ = self.api("GET", base + "&before=" + str(cursor), actor="searcher")
            seen.extend(item["id"] for item in page["cards"])
            cursor = page["next_cursor"]
        self.assertEqual(seen, list(reversed(wanted)))
        self.api("DELETE", f"/api/boards/1/members/{user}")
        page, _ = self.api("GET", base, actor="searcher")
        self.assertEqual(page, {"cards": [], "next_cursor": None})
        for query in ("&limit=0", "&limit=201", "&before=0", "&before=x", "&limit=2&limit=3"):
            self.api("GET", "/api/search?q=needle" + query, expected=400)


if __name__ == "__main__":
    unittest.main()
