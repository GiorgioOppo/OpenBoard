"""Browser converters round-trip through authenticated transactional import API."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

import test_auth

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get('NODE', 'node')


@unittest.skipUnless(shutil.which(NODE), 'Node.js is required to exercise browser converters')
class ImportFormats(unittest.TestCase):
    setUp = test_auth.OpenBoardAuth.setUp
    stop = test_auth.OpenBoardAuth.stop
    read_log = test_auth.OpenBoardAuth.read_log
    request = test_auth.OpenBoardAuth.request
    api = test_auth.OpenBoardAuth.api
    session = test_auth.OpenBoardAuth.session

    def convert(self, kind, source, options=None):
        script = ("const fs=require('node:fs'), i=require('./web/importers.js');"
                  "const request=JSON.parse(fs.readFileSync(0,'utf8'));"
                  "const result=request.kind==='trello'?i.parseTrello(request.source):"
                  "i.parseCSV(request.source,request.options);"
                  "process.stdout.write(JSON.stringify(result));")
        result = subprocess.run([NODE, '-e', script], cwd=ROOT,
                                input=json.dumps({'kind': kind, 'source': source, 'options': options}),
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def roundtrip(self, converted):
        created, _ = self.api('POST', '/api/import', converted['data'], expected=201)
        exported, _ = self.api('GET', f'/api/boards/{created["id"]}/export')
        self.assertEqual(exported['format'], 'openboard')
        self.assertEqual(exported['version'], 2)
        self.assertEqual(exported['board']['name'], converted['data']['board']['name'])
        self.assertEqual(len(exported['board']['columns']), converted['counts']['columns'])
        for expected_column, column in zip(converted['data']['board']['columns'], exported['board']['columns']):
            self.assertEqual(column['title'], expected_column['title'])
            self.assertEqual(len(column['cards']), len(expected_column['cards']))
            for expected, card in zip(expected_column['cards'], column['cards']):
                for key, value in expected.items():
                    self.assertEqual(card[key], value, key)
                self.assertIsInstance(card['id'], int)
                self.assertEqual(card['assignees'], [])
        repeated, _ = self.api('POST', '/api/import', exported, expected=201)
        self.assertNotEqual(repeated['id'], created['id'])
        return exported

    def test_trello_preserves_checklist_dates_archive_labels_and_member_display(self):
        source = {'id': 'synthetic-board', 'name': 'Synthetic Trello board', 'desc': 'No real data',
                  'lists': [{'id': 'synthetic-list', 'name': 'Synthetic list', 'closed': True}],
                  'members': [{'id': 'synthetic-member', 'fullName': 'Synthetic display name'}],
                  'cards': [{'id': 'synthetic-card', 'idList': 'synthetic-list', 'name': 'Unicode 日本語 ☕',
                             'desc': 'First\nSecond', 'idMembers': ['synthetic-member'],
                             'idChecklists': ['synthetic-checklist'], 'due': '2028-02-29T23:00:00.000Z',
                             'dueComplete': True, 'labels': [{'id': 'synthetic-label', 'name': 'External label', 'color': 'red'}]}],
                  'checklists': [{'id': 'synthetic-checklist', 'idCard': 'synthetic-card', 'name': 'Checklist group',
                                  'checkItems': [{'id': 'synthetic-item', 'name': 'Verificato ☕', 'state': 'complete'}]}]}
        converted = self.convert('trello', source)
        exported = self.roundtrip(converted)
        card = exported['board']['columns'][0]['cards'][0]
        self.assertTrue(card['archived'])
        self.assertTrue(card['completed'])
        self.assertEqual(card['labels'], [])
        self.assertIn('External label', card['description'])
        users, _ = self.api('GET', '/api/users')
        self.assertEqual(len(users['users']), 1)

    def test_csv_preserves_quotes_multiline_formulas_and_supported_fields(self):
        source = ('\ufeffTitle;List;Description;Due;Priority;Assignee;Minutes\r\n'
                  '"=2+2";Inbox;"First\r\n\"\"Second\"\"";2028-02-29;high;Synthetic member;45\r\n'
                  '"<script>synthetic</script>";Later;Literal HTML;;low;;0\r\n')
        converted = self.convert('csv', source, {'name': 'Synthetic CSV board', 'delimiter': ';',
            'mapping': {'title': 0, 'list': 1, 'description': 2, 'due_date': 3,
                        'priority': 4, 'assignee': 5, 'estimate_minutes': 6}})
        exported = self.roundtrip(converted)
        self.assertEqual(exported['board']['columns'][0]['cards'][0]['title'], '=2+2')
        self.assertEqual(exported['board']['columns'][1]['cards'][0]['title'], '<script>synthetic</script>')

    def test_converted_payload_is_still_subject_to_server_atomic_validation(self):
        converted = self.convert('csv', 'title,list\nValid,First\nInvalid,Second',
                                 {'name': 'Synthetic atomic import', 'mapping': {'title': 0, 'list': 1}})
        data = copy.deepcopy(converted['data'])
        data['board']['columns'][1]['cards'][0]['title'] = 'x' * 301
        before, _ = self.api('GET', '/api/boards')
        self.api('POST', '/api/import', data, expected=400)
        after, _ = self.api('GET', '/api/boards')
        self.assertEqual(after, before)


if __name__ == '__main__':
    unittest.main()
