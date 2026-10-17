"""Board-wide dependency reads enforce ACL, live ancestry and bounded output."""
import sqlite3
import unittest
from contextlib import closing

import test_auth


class TimelineAPI(unittest.TestCase):
    setUp = test_auth.OpenBoardAuth.setUp
    stop = test_auth.OpenBoardAuth.stop
    read_log = test_auth.OpenBoardAuth.read_log
    request = test_auth.OpenBoardAuth.request
    api = test_auth.OpenBoardAuth.api
    session = test_auth.OpenBoardAuth.session
    login = test_auth.OpenBoardAuth.login

    def board(self):
        data, _ = self.api('POST', '/api/boards', {'name': 'Synthetic timeline'}, expected=201)
        board, _ = self.api('GET', '/api/boards/' + str(data['id']))
        return board

    def card(self, column):
        data, _ = self.api('POST', f'/api/columns/{column}/cards', {'title': 'Synthetic card'}, expected=201)
        return data['id']

    def graph(self):
        board = self.board()
        a, b = self.card(board['columns'][0]['id']), self.card(board['columns'][1]['id'])
        self.api('POST', f'/api/cards/{a}/dependencies', {'required_card_id': b}, expected=201)
        return board, a, b

    def test_acl_methods_filters_and_readonly_membership(self):
        board, a, b = self.graph()
        path = f'/api/boards/{board["id"]}/timeline'
        result, headers = self.api('GET', path)
        self.assertEqual(result['dependencies'], [{'card_id': a, 'required_card_id': b}])
        self.assertFalse(result['truncated'])
        self.assertEqual(result['limit'], 2000)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.api('GET', path, actor=None, expected=401)
        self.api('POST', path, {}, expected=405)
        for query in ('include_archived=true', 'include_archived=2', 'include_archived=1&include_archived=0'):
            self.api('GET', path + '?' + query, expected=400)
        user, _ = self.api('POST', '/api/users', {'name': 'Synthetic observer', 'username': 'timeline.observer',
                          'password': test_auth.PASSWORD, 'role': 'observer'}, expected=201)
        self.login('timeline.observer')
        self.api('GET', path, actor='timeline.observer', expected=404)
        self.api('POST', f'/api/boards/{board["id"]}/members', {'user_id': user['id'], 'role': 'observer'})
        result, _ = self.api('GET', path, actor='timeline.observer')
        self.assertEqual(result['dependencies'], [{'card_id': a, 'required_card_id': b}])

    def test_archive_filter_applies_to_both_endpoints_and_board(self):
        board, a, b = self.graph()
        path = f'/api/boards/{board["id"]}/timeline'
        for card in (a, b):
            self.api('PATCH', f'/api/cards/{card}', {'archived': True})
            self.assertEqual(self.api('GET', path)[0]['dependencies'], [])
            self.assertEqual(len(self.api('GET', path + '?include_archived=1')[0]['dependencies']), 1)
            self.api('PATCH', f'/api/cards/{card}', {'archived': False})
        self.api('PATCH', f'/api/boards/{board["id"]}', {'archived': True})
        self.api('GET', path, expected=404)
        self.assertEqual(len(self.api('GET', path + '?include_archived=1')[0]['dependencies']), 1)

    def test_deleted_cards_columns_boards_and_cross_board_edges_never_leak(self):
        for endpoint in ('source-card', 'required-card', 'source-column', 'required-column', 'board'):
            with self.subTest(endpoint=endpoint):
                board, a, b = self.graph()
                other = self.board()
                foreign = self.card(other['columns'][0]['id'])
                with closing(sqlite3.connect(self.db)) as connection, connection:
                    connection.execute('INSERT INTO card_dependencies VALUES(?,?)', (a, foreign))
                path = f'/api/boards/{board["id"]}/timeline?include_archived=1'
                self.assertEqual(self.api('GET', path)[0]['dependencies'], [{'card_id': a, 'required_card_id': b}])
                resource = {'source-card': f'cards/{a}', 'required-card': f'cards/{b}',
                            'source-column': f'columns/{board["columns"][0]["id"]}',
                            'required-column': f'columns/{board["columns"][1]["id"]}',
                            'board': f'boards/{board["id"]}'}[endpoint]
                self.api('DELETE', '/api/' + resource)
                if endpoint == 'board':
                    self.api('GET', path, expected=404)
                else:
                    self.assertEqual(self.api('GET', path)[0]['dependencies'], [])

    def test_stable_two_thousand_edge_limit_reports_truncation(self):
        board = self.board()
        column = board['columns'][0]['id']
        source = self.card(column)
        with closing(sqlite3.connect(self.db)) as connection, connection:
            connection.executemany('INSERT INTO cards(column_id,title,position) VALUES(?,?,?)',
                                   [(column, 'Synthetic prerequisite', index) for index in range(2001)])
            ids = [row[0] for row in connection.execute('SELECT id FROM cards WHERE column_id=? AND id<>? ORDER BY id', (column, source))]
            connection.executemany('INSERT INTO card_dependencies VALUES(?,?)', [(source, target) for target in ids])
        result, _ = self.api('GET', f'/api/boards/{board["id"]}/timeline')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['dependencies']), 2000)
        self.assertEqual([edge['required_card_id'] for edge in result['dependencies']], ids[:2000])
        self.assertEqual(len(set(edge['card_id'] for edge in result['dependencies'])), 1)


if __name__ == '__main__':
    unittest.main()
