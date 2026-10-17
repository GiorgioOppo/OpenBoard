"""Search across collaborative data using current ACLs and stable typed cursors."""
import subprocess
import time
import unittest
from urllib.parse import urlencode

import test_auth as helpers


class CollaborativeSearch(unittest.TestCase):
    setUp = helpers.OpenBoardAuth.setUp
    stop = helpers.OpenBoardAuth.stop
    read_log = helpers.OpenBoardAuth.read_log
    request = helpers.OpenBoardAuth.request
    api = helpers.OpenBoardAuth.api
    session = helpers.OpenBoardAuth.session
    add_user = helpers.OpenBoardAuth.add_user
    login = helpers.OpenBoardAuth.login
    sql = helpers.OpenBoardAuth.sql

    def search(self, term='collaborative needle', actor='admin', **query):
        result, headers = self.api('GET', '/api/search/content?' + urlencode({'q': term, **query}), actor=actor)
        self.assertEqual(headers['cache-control'], 'no-store')
        return result

    def comment(self, body='collaborative needle', card=1, parent=None):
        payload = {'body': body}
        if parent is not None:
            payload['parent_id'] = parent
        result, _ = self.api('POST', f'/api/cards/{card}/comments', payload, expected=201)
        return result['id']

    def form_request(self):
        form, _ = self.api('POST', '/api/boards/1/intake/forms', {
            'name': 'Team form', 'description': 'Form collaborative needle', 'column_id': 1}, expected=201)
        self.api('POST', f"/api/intake/forms/{form['id']}/fields", {
            'key': 'details', 'name': 'Details', 'type': 'text'}, expected=201)
        self.api('POST', f"/api/intake/forms/{form['id']}/publish", {})
        item, _ = self.api('POST', f"/api/intake/forms/{form['id']}/requests", {
            'title': 'Routine request', 'answers': {'details': 'Answer collaborative needle 日本'}}, expected=201)
        self.api('POST', f"/api/intake/requests/{item['id']}/notes", {'body': 'Note collaborative needle'}, expected=201)
        return form['id'], item['id']

    def test_card_comment_reply_form_answers_and_notes_are_searchable(self):
        self.api('PATCH', '/api/cards/1', {'description': 'Description collaborative needle'})
        parent = self.comment('Parent collaborative needle')
        self.comment('Reply collaborative needle', parent=parent)
        form, request = self.form_request()
        result = self.search()
        self.assertEqual([item['kind'] for item in result['items']],
                         ['card', 'comment', 'comment', 'request', 'request_note', 'form'])
        self.assertEqual(len({item['key'] for item in result['items']}), 6)
        answer = next(item for item in result['items'] if item['kind'] == 'request')
        self.assertEqual((answer['request_id'], answer['form_id']), (request, form))
        self.assertIn('日本', answer['snippet'])
        self.assertIsNone(result['next_cursor'])
        self.assertTrue(all(len(item['snippet']) <= 240 for item in result['items']))
        legacy, _ = self.api('GET', '/api/search?q=collaborative%20needle&limit=30')
        self.assertEqual(len(legacy['cards']), 1)
        self.assertNotIn('items', legacy)

    def test_permissions_precede_limit_and_revocation_applies_to_cursor(self):
        member = self.add_user('searcher', 'observer')
        self.api('POST', '/api/boards/1/members', {'user_id': member, 'role': 'observer'})
        self.login('searcher')
        ids = [self.comment(f'collaborative needle {index}') for index in range(3)]
        board, _ = self.api('POST', '/api/boards', {'name': 'Private search'}, expected=201)
        detail, _ = self.api('GET', f"/api/boards/{board['id']}")
        card, _ = self.api('POST', f"/api/columns/{detail['columns'][0]['id']}/cards", {'title': 'collaborative needle PRIVATE'}, expected=201)
        self.comment('collaborative needle PRIVATE', card=card['id'])
        first = self.search(actor='searcher', limit=1)
        self.assertEqual(first['items'][0]['id'], ids[-1])
        self.assertEqual(first['items'][0]['kind'], 'comment')
        self.assertEqual(first['next_cursor'], f'1:{ids[-1]}')
        self.sql('DELETE FROM board_members WHERE board_id=1 AND user_id=?', (member,))
        self.assertEqual(self.search(actor='searcher', limit=1, cursor=first['next_cursor'])['items'], [])
        self.api('GET', '/api/search/content?q=needle', actor=None, expected=401)

    def test_stable_cursor_deduplicates_different_kinds_and_new_insertions(self):
        self.api('PATCH', '/api/cards/1', {'description': 'collaborative needle'})
        ids = [self.comment() for _ in range(4)]
        expected = ['0:1', *[f'1:{value}' for value in reversed(ids)]]
        page = self.search(limit=2)
        keys = [item['key'] for item in page['items']]
        self.comment('collaborative needle newly inserted')
        while page['next_cursor']:
            page = self.search(limit=2, cursor=page['next_cursor'])
            keys.extend(item['key'] for item in page['items'])
        self.assertEqual(keys, expected)

    def test_deleted_ancestry_and_archive_filter(self):
        self.comment()
        self.api('PATCH', '/api/cards/1', {'archived': True})
        self.assertEqual(self.search()['items'], [])
        self.assertEqual(len(self.search(include_archived=1)['items']), 1)
        self.api('DELETE', '/api/columns/1')
        self.assertEqual(self.search(include_archived=1)['items'], [])

    def test_intake_read_permissions_and_deleted_form_ancestry(self):
        form, _ = self.form_request()
        member = self.add_user('observer', 'observer')
        self.api('POST', '/api/boards/1/members', {'user_id': member, 'role': 'observer'})
        self.login('observer')
        self.assertEqual({i['kind'] for i in self.search(actor='observer')['items']}, {'request', 'request_note', 'form'})
        self.api('DELETE', f'/api/intake/forms/{form}')
        self.assertEqual(self.search(actor='observer')['items'], [])

    def test_literal_queries_and_json_values_exclude_keys(self):
        self.comment("<script> ' % _ \\ collaborative needle")
        self.assertEqual(len(self.search("' % _ \\")['items']), 1)
        self.assertEqual(self.search("' OR 1=1 --")['items'], [])
        self.form_request()
        self.assertEqual(self.search('details', kind='request')['items'], [])
        self.assertEqual(len(self.search('日本', kind='request')['items']), 1)

    def test_answer_snippets_include_late_matches_without_searching_keys(self):
        _, request = self.form_request()
        self.sql("UPDATE intake_requests SET answers=json_object('hidden-key',?1) WHERE id=?2",
                 ('a' * 400 + 'Needle 日本' + 'b' * 300, request))
        items = self.search('Needle 日本', kind='request')['items']
        self.assertEqual(len(items), 1)
        self.assertIn('Needle 日本', items[0]['snippet'])
        self.assertLessEqual(len(items[0]['snippet']), 240)

    def test_invalid_query_kinds_flags_cursor_and_methods(self):
        for query in ('q=', 'q=++', 'q=' + 'x' * 201, 'q=ok&kind=private', 'q=ok&kind=',
                      'q=ok&limit=0', 'q=ok&limit=201', 'q=ok&limit=1x', 'q=ok&cursor=1:-1',
                      'q=ok&cursor=5:1', 'q=ok&cursor=0:9223372036854775808', 'q=ok&cursor=1:1:2',
                      'q=ok&include_archived=true'):
            with self.subTest(query=query):
                self.api('GET', '/api/search/content?' + query, expected=400)
        self.api('POST', '/api/search/content', {}, expected=405)

    def test_no_auth_never_exposes_account_required_intake(self):
        self.form_request()
        self.comment()
        self.stop()
        self.process = subprocess.Popen([str(helpers.BINARY), '--db', str(self.db), '--port', str(self.port),
                                         '--no-auth', '--quiet'], cwd=helpers.ROOT, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if self.request('GET', '/api/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.025)
        self.assertEqual({item['kind'] for item in self.search(actor=None)['items']}, {'comment'})


if __name__ == '__main__':
    unittest.main()
