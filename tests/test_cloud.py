"""Real PostgreSQL/MongoDB persistence tests (opt in with OPENBOARD_CLOUD_TEST=1).

Use disposable databases in OPENBOARD_POSTGRES_URL/OPENBOARD_MONGODB_URI. The
suite adds uniquely named data, never drops databases. Migration tests also drop
introduced tables and change version metadata; enable them only on disposable
stores with OPENBOARD_CLOUD_MIGRATION_TEST=1. Driver inspection uses
ctypes and the same native libraries as the application, with no Python DB
packages. Optional outage test: OPENBOARD_CLOUD_MONGO_CONTAINER=<test container>.
"""
from concurrent.futures import ThreadPoolExecutor
import ctypes as C
import ctypes.util
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('OPENBOARD_BINARY', ROOT / 'build/openboard'))
ENABLED = os.environ.get('OPENBOARD_CLOUD_TEST') == '1'


def clean_environment():
    return {k: v for k, v in os.environ.items() if not k.startswith('OPENBOARD_')}


class CloudConfiguration(unittest.TestCase):
    def test_partial_cloud_configuration_fails_without_exposing_uri(self):
        with tempfile.TemporaryDirectory(prefix='openboard-cloud-config-') as folder:
            environment = clean_environment()
            secret = 'postgresql://private-user:do-not-log-this@127.0.0.1:9/private'
            environment['OPENBOARD_POSTGRES_URL'] = secret
            result = subprocess.run([str(BINARY), '--db', str(Path(folder)/'cache.db'),
                '--no-demo', '--quiet'], env=environment, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'do-not-log-this', result.stderr + result.stdout)
            self.assertNotIn(secret.encode(), result.stderr + result.stdout)


def native_library(packages, names):
    for name in names:
        found = ctypes.util.find_library(name)
        if found:
            return C.CDLL(found)
    for package in packages:
        result = subprocess.run(['pkg-config', '--variable=libdir', package],
                                capture_output=True, text=True)
        if result.returncode == 0:
            directory = Path(result.stdout.strip())
            for name in names:
                for filename in (f'lib{name}.dylib', f'lib{name}.so'):
                    candidate = directory / filename
                    if candidate.exists():
                        return C.CDLL(str(candidate))
    raise RuntimeError('Native cloud driver not found; configure PKG_CONFIG_PATH')


class NativeStores:
    def __init__(self):
        self.pq = native_library(['libpq'], ['pq'])
        self.mongo = native_library(['mongoc2', 'libmongoc-1.0'], ['mongoc2', 'mongoc-1.0'])
        self.bson = native_library(['bson2', 'libbson-1.0'], ['bson2', 'bson-1.0'])
        for name, args, result in [
            ('PQconnectdb', [C.c_char_p], C.c_void_p),
            ('PQstatus', [C.c_void_p], C.c_int),
            ('PQexec', [C.c_void_p, C.c_char_p], C.c_void_p),
            ('PQresultStatus', [C.c_void_p], C.c_int),
            ('PQntuples', [C.c_void_p], C.c_int),
            ('PQnfields', [C.c_void_p], C.c_int),
            ('PQgetisnull', [C.c_void_p, C.c_int, C.c_int], C.c_int),
            ('PQgetvalue', [C.c_void_p, C.c_int, C.c_int], C.c_char_p),
            ('PQclear', [C.c_void_p], None), ('PQfinish', [C.c_void_p], None)]:
            function = getattr(self.pq, name)
            function.argtypes, function.restype = args, result
        for name, args, result in [
            ('mongoc_init', [], None),
            ('mongoc_client_new', [C.c_char_p], C.c_void_p),
            ('mongoc_client_destroy', [C.c_void_p], None),
            ('mongoc_client_command_simple', [C.c_void_p, C.c_char_p, C.c_void_p,
              C.c_void_p, C.c_void_p, C.c_void_p], C.c_bool)]:
            function = getattr(self.mongo, name)
            function.argtypes, function.restype = args, result
        for name, args, result in [
            ('bson_new', [], C.c_void_p),
            ('bson_new_from_json', [C.c_char_p, C.c_ssize_t, C.c_void_p], C.c_void_p),
            ('bson_as_relaxed_extended_json', [C.c_void_p, C.c_void_p], C.c_void_p),
            ('bson_destroy', [C.c_void_p], None), ('bson_free', [C.c_void_p], None)]:
            function = getattr(self.bson, name)
            function.argtypes, function.restype = args, result
        self.mongo.mongoc_init()
        self.postgres = self.pq.PQconnectdb(os.environ['OPENBOARD_POSTGRES_URL'].encode())
        if not self.postgres or self.pq.PQstatus(self.postgres) != 0:
            raise RuntimeError('Test PostgreSQL unavailable')
        self.client = self.mongo.mongoc_client_new(os.environ['OPENBOARD_MONGODB_URI'].encode())
        if not self.client:
            raise RuntimeError('Test MongoDB URI invalid')
        self.database = urlsplit(os.environ['OPENBOARD_MONGODB_URI']).path.strip('/') or 'openboard'

    def sql(self, statement):
        result = self.pq.PQexec(self.postgres, statement.encode())
        try:
            if not result or self.pq.PQresultStatus(result) != 2:
                raise AssertionError('PostgreSQL inspection failed')
            return [[None if self.pq.PQgetisnull(result, row, col) else
                     self.pq.PQgetvalue(result, row, col).decode()
                     for col in range(self.pq.PQnfields(result))]
                    for row in range(self.pq.PQntuples(result))]
        finally:
            self.pq.PQclear(result)

    def command(self, command):
        encoded = json.dumps(command).encode()
        request = self.bson.bson_new_from_json(encoded, len(encoded), None)
        reply = self.bson.bson_new()
        output = None
        try:
            if not self.mongo.mongoc_client_command_simple(self.client,
                    self.database.encode(), request, None, reply, None):
                raise AssertionError('MongoDB inspection failed')
            output = self.bson.bson_as_relaxed_extended_json(reply, None)
            return json.loads(C.string_at(output))
        finally:
            self.bson.bson_free(output)
            self.bson.bson_destroy(request)
            self.bson.bson_destroy(reply)

    def close(self):
        self.pq.PQfinish(self.postgres)
        self.mongo.mongoc_client_destroy(self.client)


@unittest.skipUnless(ENABLED, 'Set OPENBOARD_CLOUD_TEST=1 for real PostgreSQL/MongoDB tests')
class CloudPersistence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.environ.get('OPENBOARD_POSTGRES_URL') or not os.environ.get('OPENBOARD_MONGODB_URI'):
            raise unittest.SkipTest('Both disposable external database URLs are required')
        cls.stores = NativeStores()

    @classmethod
    def tearDownClass(cls):
        cls.stores.close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openboard-cloud-')
        self.addCleanup(self.temp.cleanup)
        self.processes = []
        self.counter = 0
        self.name = 'cloud-test-' + uuid.uuid4().hex
        self.addCleanup(self.stop_all)
        self.first = self.start()

    def stop_all(self):
        for process, log, _, _ in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            log.close()

    def start(self, *extra):
        self.counter += 1
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0))
            port = reserve.getsockname()[1]
        cache = Path(self.temp.name) / f'cache-{self.counter}.db'
        log = tempfile.TemporaryFile()
        environment = clean_environment()
        for variable in ('OPENBOARD_POSTGRES_URL', 'OPENBOARD_MONGODB_URI'):
            environment[variable] = os.environ[variable]
        process = subprocess.Popen([str(BINARY), '--port', str(port), '--workers', '4',
            '--db', str(cache), '--no-auth', '--no-demo', '--quiet', *extra],
            stdout=log, stderr=log, env=environment)
        self.processes.append((process, log, port, cache))
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if process.poll() is not None:
                log.seek(0)
                self.fail('Cloud server exited: ' + log.read().decode(errors='replace'))
            try:
                if self.request(port, 'GET', '/api/ready')[0] == 200:
                    return port
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.05)
        self.fail('Cloud server did not become ready')

    def request(self, port, method, path, data=None, key=None, headers=None):
        headers = dict(headers or {})
        if data is not None:
            data = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        if key:
            headers['Idempotency-Key'] = key
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=25)
        try:
            connection.request(method, path, data, headers)
            response = connection.getresponse()
            body = response.read()
            return response.status, dict(response.getheaders()), json.loads(body) if body else None
        finally:
            connection.close()

    def api(self, method, path, data=None, port=None, expected=200, key=None, headers=None):
        status, _, body = self.request(port or self.first, method, path, data, key, headers)
        self.assertEqual(status, expected, body)
        return body

    def new_board(self):
        created = self.api('POST', '/api/boards', {'name':self.name}, expected=201)
        return self.api('GET', f'/api/boards/{created["id"]}')

    def test_incremental_publication_preserves_unrelated_sql_rows_and_documents(self):
        board = self.new_board()
        column = board['columns'][0]['id']
        changed = self.api('POST', f'/api/columns/{column}/cards',
                           {'title': self.name + '-changed'}, expected=201)['id']
        untouched = self.api('POST', f'/api/columns/{column}/cards',
                             {'title': self.name + '-untouched',
                              'checklist': [{'id': 'keep', 'text': self.name, 'done': False}]},
                             expected=201)['id']
        original_row = self.stores.sql(
            f'SELECT ctid::text,xmin::text,checklist__doc FROM ob_cards WHERE id={untouched}')
        self.api('PATCH', f'/api/cards/{changed}',
                 {'title': self.name + '-updated',
                  'checklist': [{'id': 'new', 'text': self.name + '-new', 'done': True}]})
        self.assertEqual(self.stores.sql(
            f'SELECT ctid::text,xmin::text,checklist__doc FROM ob_cards WHERE id={untouched}'), original_row)
        comment = self.api('POST', f'/api/cards/{changed}/comments',
                           {'body': self.name + '-comment'}, expected=201)['id']
        self.api('DELETE', f'/api/comments/{comment}')
        self.assertEqual(self.stores.sql(f'SELECT id FROM ob_comments WHERE id={comment}'), [])
        self.assertEqual(self.stores.sql(
            f'SELECT ctid::text,xmin::text,checklist__doc FROM ob_cards WHERE id={untouched}'), original_row)
        reference = original_row[0][2]
        document = self.stores.command({'find': 'documents', 'filter': {'_id': reference},
                                       'limit': 1})['cursor']['firstBatch'][0]
        self.assertEqual(document['value'], [{'id': 'keep', 'text': self.name, 'done': False}])

    def test_incremental_writes_from_two_replicas_keep_all_independent_updates(self):
        board = self.new_board()
        column = board['columns'][0]['id']
        cards = [self.api('POST', f'/api/columns/{column}/cards',
                          {'title': self.name + f'-{i}'}, expected=201)['id'] for i in range(5)]
        untouched = self.stores.sql(f'SELECT ctid::text,xmin::text FROM ob_cards WHERE id={cards[-1]}')
        second = self.start()

        def update(index):
            return self.request(self.first if index % 2 else second, 'PATCH',
                                f'/api/cards/{cards[index]}', {'title': self.name + f'-updated-{index}'})[0]

        with ThreadPoolExecutor(max_workers=4) as workers:
            self.assertEqual(list(workers.map(update, range(4))), [200] * 4)
        for index, card in enumerate(cards[:-1]):
            self.assertEqual(self.api('GET', f'/api/cards/{card}', port=second)['title'],
                             self.name + f'-updated-{index}')
        self.assertEqual(self.stores.sql(
            f'SELECT ctid::text,xmin::text FROM ob_cards WHERE id={cards[-1]}'), untouched)

    def test_incremental_sql_failure_rolls_back_publication_and_invalidates_cache(self):
        board = self.new_board()
        card = self.api('POST', f'/api/columns/{board["columns"][0]["id"]}/cards',
                        {'title': self.name}, expected=201)['id']
        original = self.api('GET', f'/api/cards/{card}')
        row = self.stores.sql(f'SELECT title,checklist__doc FROM ob_cards WHERE id={card}')
        epoch = self.stores.sql('SELECT epoch FROM ob_store')
        function = 'cloud_failure_' + uuid.uuid4().hex
        trigger = function + '_trigger'
        self.stores.sql(f"CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                        f"BEGIN IF NEW.id={card} AND NEW.title='injected-failure' THEN "
                        "RAISE EXCEPTION 'disposable publication failure'; END IF; RETURN NEW; END $$; "
                        f'CREATE TRIGGER {trigger} BEFORE INSERT OR UPDATE ON ob_cards '
                        f'FOR EACH ROW EXECUTE FUNCTION {function}(); SELECT 1')
        try:
            self.api('PATCH', f'/api/cards/{card}',
                     {'title': 'injected-failure',
                      'checklist': [{'id': 'failed', 'text': self.name, 'done': False}]}, expected=503)
            self.assertEqual(self.stores.sql(f'SELECT title,checklist__doc FROM ob_cards WHERE id={card}'), row)
            self.assertEqual(self.stores.sql('SELECT epoch FROM ob_store'), epoch)
            self.assertEqual(self.api('GET', f'/api/cards/{card}'), original)
            recovered = self.start()
            self.assertEqual(self.api('GET', f'/api/cards/{card}', port=recovered), original)
        finally:
            self.stores.sql(f'DROP TRIGGER IF EXISTS {trigger} ON ob_cards; '
                            f'DROP FUNCTION IF EXISTS {function}(); SELECT 1')
        self.api('PATCH', f'/api/cards/{card}', {'title': self.name + '-retry'})
        self.assertEqual(self.api('GET', f'/api/cards/{card}')['title'], self.name + '-retry')

    def test_existing_document_corruption_rejects_rehydration_and_publication(self):
        board = self.new_board()
        checklist = [{'id': 'integrity', 'text': self.name, 'done': False}]
        card = self.api('POST', f'/api/columns/{board["columns"][0]["id"]}/cards',
                        {'title': self.name, 'checklist': checklist}, expected=201)['id']
        reference = self.stores.sql(f'SELECT checklist__doc FROM ob_cards WHERE id={card}')[0][0]
        epoch = self.stores.sql('SELECT epoch FROM ob_store')
        environment = clean_environment()
        environment.update({k: os.environ[k] for k in ('OPENBOARD_POSTGRES_URL', 'OPENBOARD_MONGODB_URI')})
        for field, invalid, original in [('kind', 'altered.kind', 'cards.checklist'),
                                          ('value', [{'tampered': True}], checklist)]:
            with self.subTest(field=field):
                update = {'update': 'documents', 'updates': [{'q': {'_id': reference},
                          'u': {'$set': {field: invalid}}}]}
                self.stores.command(update)
                try:
                    result = subprocess.run([str(BINARY), '--db',
                        str(Path(self.temp.name) / f'corrupt-{field}.db'), '--no-demo',
                        '--backup', str(Path(self.temp.name) / f'rejected-{field}.db')],
                        env=environment, capture_output=True, timeout=25)
                    self.assertNotEqual(result.returncode, 0)
                    # The warm cache must not publish references to a document
                    # merely because $setOnInsert accepts its existing ID.
                    self.api('PATCH', f'/api/cards/{card}', {'title': self.name + '-rejected'}, expected=503)
                    self.assertEqual(self.stores.sql('SELECT epoch FROM ob_store'), epoch)
                    self.assertEqual(self.stores.sql(f'SELECT title FROM ob_cards WHERE id={card}'), [[self.name]])
                finally:
                    self.stores.command({'update': 'documents', 'updates': [{'q': {'_id': reference},
                                         'u': {'$set': {field: original}}}]})
                self.assertEqual(self.api('GET', f'/api/cards/{card}')['title'], self.name)

    def authenticate(self, port=None, username='cloud.admin'):
        port = port or self.start('--auth')
        credentials = {'username': username, 'password': 'Cloud-test-password-1016!'}
        setup = self.api('GET', '/api/auth/session', port=port)['setup_required']
        if setup:
            credentials['name'] = 'Cloud test admin'
        status, headers, session = self.request(port, 'POST',
            '/api/auth/setup' if setup else '/api/auth/login', credentials)
        self.assertEqual(status, 201 if setup else 200)
        return port, {'Cookie': headers['Set-Cookie'].split(';')[0], 'X-CSRF-Token': session['csrf']}

    def stop_processes(self):
        for process, _, _, _ in self.processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)

    def test_cached_authenticated_reply_respects_revocation_after_cold_cache(self):
        port, admin = self.authenticate()
        username = 'audit.member.' + uuid.uuid4().hex[:16]
        password = 'Disposable-security-test-1016!'
        member = self.api('POST', '/api/users', {'name': 'Audit member', 'username': username,
                          'password': password, 'role': 'member'}, port=port, headers=admin, expected=201)
        board = self.api('POST', '/api/boards', {'name': self.name}, port=port, headers=admin, expected=201)
        self.api('POST', f"/api/boards/{board['id']}/members", {'user_id': member['id'], 'role': 'admin'},
                 port=port, headers=admin)
        status, headers, session = self.request(port, 'POST', '/api/auth/login',
                                               {'username': username, 'password': password})
        self.assertEqual(status, 200)
        member_headers = {'Cookie': headers['Set-Cookie'].split(';')[0], 'X-CSRF-Token': session['csrf']}
        path, payload, key = f"/api/boards/{board['id']}/sprints", {'name': self.name + '-sprint'}, uuid.uuid4().hex
        created = self.api('POST', path, payload, port=port, headers=member_headers, key=key, expected=201)
        self.assertEqual(self.api('POST', path, payload, port=port, headers=member_headers,
                                  key=key, expected=201), created)
        self.api('DELETE', f"/api/boards/{board['id']}/members/{member['id']}", port=port, headers=admin)
        restarted = self.start('--auth')
        status, response_headers, denied = self.request(restarted, 'POST', path, payload,
                                                       key=key, headers=member_headers)
        self.assertEqual(status, 404, denied)
        self.assertNotIn('Idempotency-Replayed', response_headers)
        self.assertNotIn('sprint', denied)

    def test_accounts_sessions_and_comments_survive_new_cache(self):
        authenticated = self.start('--auth')
        session = self.api('GET', '/api/auth/session', port=authenticated)
        credentials = {'username':'cloud.admin', 'password':'Cloud-test-password-1016!'}
        path = '/api/auth/login'
        expected = 200
        if session['setup_required']:
            credentials['name'] = 'Cloud test admin'
            path, expected = '/api/auth/setup', 201
        status, response_headers, session = self.request(authenticated, 'POST', path, credentials)
        self.assertEqual(status, expected, session)
        headers = {'Cookie':response_headers['Set-Cookie'].split(';')[0],
                   'X-CSRF-Token':session['csrf']}
        board_id = self.api('POST','/api/boards',{'name':self.name},port=authenticated,
                            headers=headers,expected=201)['id']
        board = self.api('GET',f'/api/boards/{board_id}',port=authenticated,headers=headers)
        card_id = self.api('POST',f'/api/columns/{board["columns"][0]["id"]}/cards',
            {'title':self.name},port=authenticated,headers=headers,expected=201)['id']
        comment_id = self.api('POST',f'/api/cards/{card_id}/comments',{'body':'Durable comment'},
                 port=authenticated,headers=headers,expected=201)['id']
        comments = self.api('GET',f'/api/cards/{card_id}/comments',port=authenticated,headers=headers)
        for process, _, port, _ in self.processes:
            if port == authenticated:
                process.terminate(); process.wait(timeout=15)
        recovered = self.start('--auth')
        session = self.api('GET','/api/auth/session',port=recovered,headers=headers)
        self.assertEqual(session['user']['username'],'cloud.admin')
        self.assertEqual(self.api('GET',f'/api/cards/{card_id}/comments',port=recovered,headers=headers),comments)
        self.assertEqual(self.stores.command({'count':'documents','query':{
            'kind':{'$in':['users.password_hash','sessions.token_hash','sessions.csrf']}}})['n'],0)
        self.api('DELETE',f'/api/comments/{comment_id}',port=recovered,headers=headers)
        after_deletion = self.start('--auth')
        next_comment = self.api('POST',f'/api/cards/{card_id}/comments',{'body':'Next comment'},
            port=after_deletion,headers=headers,expected=201)['id']
        self.assertGreater(next_comment,comment_id, 'Rehydration must preserve deleted ID high-water marks')

    def test_structured_rows_typed_json_and_cache_reconstruction(self):
        board = self.new_board()
        checklist = [{'id':'typed', 'text':'Caffè ☕', 'done':False}]
        created = self.api('POST', f'/api/columns/{board["columns"][0]["id"]}/cards',
            {'title':self.name, 'checklist':checklist, 'labels':['design','ricerca']}, expected=201)
        card_id = created['id']
        card = self.api('GET', f'/api/cards/{card_id}')
        rows = self.stores.sql(f'SELECT title,checklist__doc,labels__doc FROM ob_cards WHERE id={card_id}')
        self.assertEqual(rows[0][0], self.name)
        self.assertEqual(len(rows[0][1]), 64)
        raw_columns = self.stores.sql("SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='ob_cards' "
            "AND column_name IN('checklist','labels','custom_values')")
        self.assertEqual(raw_columns, [])
        doc = self.stores.command({'find':'documents', 'filter':{'_id':rows[0][1]}, 'limit':1})['cursor']['firstBatch'][0]
        self.assertEqual(doc['kind'], 'cards.checklist')
        self.assertEqual(doc['value'], checklist)
        self.assertEqual(json.loads(doc['raw']), checklist)
        self.assertGreater(int(self.stores.sql("SELECT seq FROM ob_sqlite_sequence WHERE name='cards'")[0][0]), 0)
        process, _, _, _ = self.processes[0]
        process.terminate(); process.wait(timeout=15)
        fresh = self.start()
        recovered = self.api('GET', f'/api/cards/{card_id}', port=fresh)
        self.assertEqual(recovered, card)
        backup = Path(self.temp.name)/'external-backup.db'
        environment = clean_environment()
        environment.update({k:os.environ[k] for k in ('OPENBOARD_POSTGRES_URL','OPENBOARD_MONGODB_URI')})
        result = subprocess.run([str(BINARY), '--db', str(Path(self.temp.name)/'backup-cache.db'),
            '--no-demo', '--backup', str(backup)], env=environment, capture_output=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        import sqlite3
        with sqlite3.connect(backup) as connection:
            title, stored_checklist = connection.execute(
                'SELECT title,checklist FROM cards WHERE id=?', (card_id,)).fetchone()
            self.assertEqual(title, self.name)
            self.assertEqual(json.loads(stored_checklist), checklist)

    def test_two_replicas_refresh_versions_and_idempotency(self):
        second = self.start()
        payload = {'name':self.name}
        key = uuid.uuid4().hex
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda port:self.request(port,'POST','/api/boards',payload,key),
                                    [self.first,second]))
        self.assertEqual([r[0] for r in results], [201,201])
        self.assertEqual(results[0][2], results[1][2])
        self.assertTrue(any(r[1].get('Idempotency-Replayed') == 'true' for r in results))
        board_id = results[0][2]['id']
        board = self.api('GET',f'/api/boards/{board_id}',port=second)
        card_id = self.api('POST',f'/api/columns/{board["columns"][0]["id"]}/cards',
            {'title':self.name},expected=201)['id']
        initial = self.api('GET',f'/api/cards/{card_id}',port=second)
        self.api('PATCH',f'/api/cards/{card_id}',{'title':self.name+' edited'},port=second)
        current = self.api('GET',f'/api/cards/{card_id}')
        self.assertEqual(current['title'],self.name+' edited')
        self.assertEqual(current['version'],initial['version']+1)
        self.assertEqual(self.api('GET',f'/api/boards/{board_id}'),
                         self.api('GET',f'/api/boards/{board_id}',port=second))
        self.assertEqual(int(self.stores.sql(f'SELECT count(*) FROM ob_boards WHERE id={board_id}')[0][0]),1)

    def test_json_extended_operator_keys_remain_literal_and_typed(self):
        special = {'$date':'not-a-date', '$oid':'ordinary text', '$numberLong':'arbitrary label',
                   'nested':{'array':[True,False,None,{'$binary':'literal'}]},
                   'integer':9223372036854775807, 'real':1.25, 'unicode':'Caffè ☕'}
        key = uuid.uuid4().hex
        payload = {'name':self.name, 'extra':special}
        created = self.api('POST','/api/boards',payload,expected=201,key=key)
        self.assertEqual(created,self.api('POST','/api/boards',payload,expected=201,key=key))
        reference = self.stores.sql(f"SELECT request_body__doc FROM ob_idempotency WHERE key='{key}'")[0][0]
        document = self.stores.command({'find':'documents','filter':{'_id':reference},'limit':1})['cursor']['firstBatch'][0]
        self.assertEqual(json.loads(document['raw']),payload)
        # libbson's JSON renderer itself applies Extended JSON rendering to an
        # integer > 2^53. Inspect regular keys/types without conflating renderers.
        self.assertEqual(document['value']['extra']['$date'],'not-a-date')
        self.assertEqual(document['value']['extra']['$oid'],'ordinary text')
        self.assertEqual(document['value']['extra']['$numberLong'],'arbitrary label')
        self.assertEqual(document['value']['extra']['nested'],special['nested'])
        self.assertEqual(document['value']['extra']['unicode'],special['unicode'])
        fresh = self.start()
        self.assertEqual(created,self.api('POST','/api/boards',payload,port=fresh,expected=201,key=key))

    def test_unsupported_json_is_rejected_before_mutating_external_data(self):
        deep = 'leaf'
        for _ in range(91):
            deep = {'nested':deep}
        for extra in (deep, {'null\x00key':'literal'}):
            with self.subTest(extra='depth' if extra is deep else 'NUL key'):
                self.api('POST','/api/boards',{'name':self.name,'extra':extra},
                         expected=400,key=uuid.uuid4().hex)
        self.assertNotIn(self.name,[b['name'] for b in self.api('GET','/api/boards')['boards']])
        self.api('POST','/api/boards',{'name':self.name},expected=201)
        self.assertEqual(self.request(self.first,'GET','/api/ready')[0],200)

    def test_new_reviews_reports_and_json_filters_survive_cold_cache_and_backup(self):
        authenticated = self.start('--auth')
        credentials = {'username': 'cloud.admin', 'password': 'Cloud-test-password-1016!'}
        setup = self.api('GET', '/api/auth/session', port=authenticated)['setup_required']
        if setup:
            credentials['name'] = 'Cloud test admin'
        status, response_headers, session = self.request(authenticated, 'POST',
            '/api/auth/setup' if setup else '/api/auth/login', credentials)
        self.assertEqual(status, 201 if setup else 200)
        headers = {'Cookie': response_headers['Set-Cookie'].split(';')[0], 'X-CSRF-Token': session['csrf']}
        board_id = self.api('POST', '/api/boards', {'name': self.name}, port=authenticated,
                            headers=headers, expected=201)['id']
        board = self.api('GET', f'/api/boards/{board_id}', port=authenticated, headers=headers)
        card_id = self.api('POST', f'/api/columns/{board["columns"][0]["id"]}/cards',
            {'title': 'Caffè di revisione'}, port=authenticated, headers=headers, expected=201)['id']
        username = 'reviewer.' + uuid.uuid4().hex[:12]
        reviewer_id = self.api('POST', '/api/users', {'username': username, 'name': 'Revisore',
            'password': credentials['password'], 'role': 'member'}, port=authenticated,
            headers=headers, expected=201)['id']
        self.api('POST', f'/api/boards/{board_id}/members', {'user_id': reviewer_id, 'role': 'member'},
                 port=authenticated, headers=headers)
        review = self.api('POST', f'/api/cards/{card_id}/reviews', {'title': self.name,
            'reviewer_ids': [reviewer_id], 'policy': 'all'}, port=authenticated,
            headers=headers, expected=201)
        status, reviewer_headers, reviewer_session = self.request(authenticated, 'POST', '/api/auth/login',
            {'username': username, 'password': credentials['password']})
        self.assertEqual(status, 200)
        reviewer_headers = {'Cookie': reviewer_headers['Set-Cookie'].split(';')[0],
                            'X-CSRF-Token': reviewer_session['csrf']}
        approved = self.api('POST', f'/api/reviews/{review["id"]}/vote',
            {'decision': 'approved', 'note': 'Verificato ☕'}, port=authenticated, headers=reviewer_headers)
        self.assertEqual(approved['status'], 'approved')
        filters = {'q': 'Caffè', 'board_id': board_id, 'status': 'open', 'include_archived': False}
        report = self.api('POST', '/api/me/reports', {'name': self.name, 'filters': filters, 'pinned': True},
            port=authenticated, headers=headers, expected=201)
        reference = self.stores.sql(f'SELECT filters__doc FROM ob_saved_reports WHERE id={report["id"]}')[0][0]
        document = self.stores.command({'find': 'documents', 'filter': {'_id': reference},
                                       'limit': 1})['cursor']['firstBatch'][0]
        self.assertEqual(document['kind'], 'saved_reports.filters')
        self.assertEqual(document['value'], filters)
        self.assertEqual(json.loads(document['raw']), filters)
        self.assertEqual(self.stores.sql(f'SELECT title FROM ob_reviews WHERE id={review["id"]}')[0][0], self.name)
        for process, _, _, _ in self.processes:
            process.terminate()
            process.wait(timeout=15)
        recovered = self.start('--auth')
        restored = self.api('GET', f'/api/reviews/{review["id"]}', port=recovered, headers=headers)
        self.assertEqual(restored['status'], 'approved')
        self.assertEqual(restored['reviewers'][0]['note'], 'Verificato ☕')
        self.assertEqual(self.api('GET', f'/api/reports/{report["id"]}', port=recovered, headers=headers), report)
        history = self.api('GET', f'/api/reviews/{review["id"]}/history', port=recovered, headers=headers)
        self.assertGreaterEqual(len(history['items']), 2)
        backup = Path(self.temp.name) / 'enterprise-backup.db'
        environment = clean_environment()
        environment.update({k: os.environ[k] for k in ('OPENBOARD_POSTGRES_URL', 'OPENBOARD_MONGODB_URI')})
        result = subprocess.run([str(BINARY), '--db', str(Path(self.temp.name) / 'backup-cache.db'),
            '--no-demo', '--backup', str(backup)], env=environment, capture_output=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        import sqlite3
        with sqlite3.connect(backup) as connection:
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(connection.execute('SELECT decision,note FROM review_votes WHERE review_id=?',
                (review['id'],)).fetchone(), ('approved', 'Verificato ☕'))
            self.assertEqual(json.loads(connection.execute('SELECT filters FROM saved_reports WHERE id=?',
                (report['id'],)).fetchone()[0]), filters)

    @unittest.skipUnless(os.environ.get('OPENBOARD_CLOUD_MIGRATION_TEST') == '1',
                         'Set OPENBOARD_CLOUD_MIGRATION_TEST=1 only for disposable stores')
    def test_schema_six_upgrade_keeps_approved_review_and_original_report_document(self):
        port, headers = self.authenticate()
        board_id = self.api('POST', '/api/boards', {'name': self.name}, port=port,
                            headers=headers, expected=201)['id']
        board = self.api('GET', f'/api/boards/{board_id}', port=port, headers=headers)
        card_id = self.api('POST', f'/api/columns/{board["columns"][0]["id"]}/cards',
            {'title': 'Da conservare nella migrazione 6 → 7'}, port=port, headers=headers, expected=201)['id']
        username = 'migration.' + uuid.uuid4().hex[:12]
        reviewer_id = self.api('POST', '/api/users', {'username': username, 'name': 'Revisore migrazione',
            'password': 'Cloud-test-password-1016!', 'role': 'member'}, port=port, headers=headers, expected=201)['id']
        self.api('POST', f'/api/boards/{board_id}/members', {'user_id': reviewer_id, 'role': 'member'},
                 port=port, headers=headers)
        review = self.api('POST', f'/api/cards/{card_id}/reviews', {'title': self.name,
            'reviewer_ids': [reviewer_id]}, port=port, headers=headers, expected=201)
        _, reviewer_headers = self.authenticate(port, username)
        self.api('POST', f'/api/reviews/{review["id"]}/vote', {'decision': 'approved', 'note': 'Da conservare'},
                 port=port, headers=reviewer_headers)
        filters = {'q': 'Caffè ☕', 'board_id': board_id, 'include_archived': False}
        report = self.api('POST', '/api/me/reports', {'name': self.name, 'filters': filters, 'pinned': True},
                         port=port, headers=headers, expected=201)
        reference = self.stores.sql(f'SELECT filters__doc FROM ob_saved_reports WHERE id={report["id"]}')[0][0]
        self.stop_processes()
        self.stores.sql("DROP TABLE ob_sprint_cards,ob_sprint_capacity,ob_sprint_snapshots,ob_sprint_events,ob_sprints,"
            "ob_intake_fields,ob_intake_requests,ob_intake_notes,ob_intake_events,ob_intake_forms; "
            "DELETE FROM ob_sqlite_sequence WHERE name IN('sprints','sprint_events','intake_forms',"
            "'intake_fields','intake_requests','intake_notes','intake_events'); "
            "UPDATE ob_store SET schema_version=6; SELECT schema_version FROM ob_store")
        recovered = self.start('--auth')
        self.assertEqual(self.stores.sql('SELECT schema_version FROM ob_store'), [['7']])
        self.assertEqual(self.stores.sql(f'SELECT filters__doc FROM ob_saved_reports WHERE id={report["id"]}'), [[reference]])
        self.assertEqual(self.api('GET', f'/api/reports/{report["id"]}', port=recovered, headers=headers), report)
        restored = self.api('GET', f'/api/reviews/{review["id"]}', port=recovered, headers=headers)
        self.assertEqual(restored['status'], 'approved')
        self.assertEqual(restored['reviewers'][0]['note'], 'Da conservare')

    def test_workflow_sprints_typed_requests_conversion_and_snapshots_survive_cold_cache_and_backup(self):
        port, headers = self.authenticate()
        session = self.api('GET', '/api/auth/session', port=port, headers=headers)
        user_id = session['user']['id']
        board_id = self.api('POST', '/api/boards', {'name': self.name}, port=port,
                            headers=headers, expected=201)['id']
        board = self.api('GET', f'/api/boards/{board_id}', port=port, headers=headers)
        column_id = board['columns'][0]['id']
        card_id = self.api('POST', f'/api/columns/{column_id}/cards',
            {'title': 'Lavoro pianificato', 'estimate_minutes': 45, 'assignee_ids': [user_id]},
            port=port, headers=headers, expected=201)['id']
        sprint = self.api('POST', f'/api/boards/{board_id}/sprints', {'name': self.name,
            'goal': 'Persistenza completa', 'start_date': '2026-10-16', 'end_date': '2026-10-30'},
            port=port, headers=headers, expected=201)
        sid = sprint['id']
        self.api('POST', f'/api/sprints/{sid}/cards', {'card_id': card_id}, port=port, headers=headers)
        self.api('PATCH', f'/api/sprints/{sid}/capacity/{user_id}', {'minutes': 120}, port=port, headers=headers)
        self.api('POST', f'/api/sprints/{sid}/activate', {}, port=port, headers=headers)
        form = self.api('POST', f'/api/boards/{board_id}/intake/forms', {'name': self.name,
            'description': 'Un modulo da conservare', 'column_id': column_id}, port=port, headers=headers, expected=201)
        fid = form['id']
        for field in [{'key': 'score', 'name': 'Punteggio', 'type': 'number', 'required': True},
                      {'key': 'ready', 'name': 'Pronto', 'type': 'boolean', 'required': True},
                      {'key': 'choice', 'name': 'Scelta', 'type': 'select', 'options': ['Caffè ☕', 'Altro'], 'required': True}]:
            self.api('POST', f'/api/intake/forms/{fid}/fields', field, port=port, headers=headers, expected=201)
        form = self.api('POST', f'/api/intake/forms/{fid}/publish', {}, port=port, headers=headers)
        answers = {'score': 0, 'ready': False, 'choice': 'Caffè ☕'}
        request = self.api('POST', f'/api/intake/forms/{fid}/requests', {'title': 'Richiesta Unicode ☕', 'answers': answers},
            port=port, headers={**headers, 'If-Match': str(form['version'])}, expected=201)
        rid = request['id']
        original_schema = request['schema_snapshot']
        self.api('POST', f'/api/intake/requests/{rid}/notes', {'body': 'Contesto da conservare'}, port=port, headers=headers, expected=201)
        self.api('POST', f'/api/intake/requests/{rid}/state', {'state': 'accepted'}, port=port, headers=headers)
        converted = self.api('POST', f'/api/intake/requests/{rid}/convert', {}, port=port, headers=headers)
        converted_id = converted['converted_card_id']
        self.assertGreater(converted_id, 0)
        self.assertEqual(self.api('GET', f'/api/cards/{converted_id}', port=port, headers=headers)['title'], 'Richiesta Unicode ☕')
        self.api('POST', f'/api/sprints/{sid}/cards', {'card_id': converted_id}, port=port, headers=headers)
        sprint = self.api('GET', f'/api/sprints/{sid}', port=port, headers=headers)
        self.api('POST', f'/api/sprints/{sid}/snapshots', {}, port=port,
                 headers={**headers, 'If-Match': str(sprint['version'])})
        references = self.stores.sql(f'SELECT answers__doc,schema_snapshot__doc FROM ob_intake_requests WHERE id={rid}')[0]
        for reference, kind, value in zip(references, ('answers', 'schema_snapshot'), (answers, original_schema)):
            document = self.stores.command({'find': 'documents', 'filter': {'_id': reference},
                                           'limit': 1})['cursor']['firstBatch'][0]
            self.assertEqual(document['kind'], 'intake_requests.' + kind)
            self.assertEqual(document['value'], value)
            self.assertEqual(json.loads(document['raw']), value)
        self.assertEqual(self.stores.sql("SELECT column_name FROM information_schema.columns WHERE table_name='ob_intake_requests' "
            "AND column_name IN('answers','schema_snapshot')"), [])
        self.stop_processes()
        # Nullable structured targets survive rehydration when a destination
        # column has been permanently removed; historical answers remain valid.
        self.stores.sql(f'UPDATE ob_intake_forms SET column_id=NULL,published=0,version=version+1 WHERE id={fid}; SELECT 1')
        recovered = self.start('--auth')
        restored = self.api('GET', f'/api/intake/requests/{rid}', port=recovered, headers=headers)
        self.assertEqual(restored['answers'], answers)
        self.assertEqual(restored['schema_snapshot'], original_schema)
        self.assertEqual(restored['converted_card_id'], converted_id)
        self.assertIsNone(self.api('GET', f'/api/intake/forms/{fid}', port=recovered, headers=headers)['column_id'])
        self.assertEqual(self.api('GET', f'/api/sprints/{sid}', port=recovered, headers=headers)['state'], 'active')
        self.assertEqual(len(self.api('GET', f'/api/sprints/{sid}/cards', port=recovered, headers=headers)['items']), 2)
        self.assertEqual(len(self.api('GET', f'/api/sprints/{sid}/snapshots', port=recovered, headers=headers)['items']), 1)
        backup = Path(self.temp.name) / 'workflows-backup.db'
        environment = clean_environment()
        environment.update({k: os.environ[k] for k in ('OPENBOARD_POSTGRES_URL', 'OPENBOARD_MONGODB_URI')})
        result = subprocess.run([str(BINARY), '--db', str(Path(self.temp.name) / 'backup-cache.db'),
            '--no-demo', '--backup', str(backup)], env=environment, capture_output=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        import sqlite3
        with sqlite3.connect(backup) as connection:
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            raw, schema, card = connection.execute('SELECT answers,schema_snapshot,converted_card_id FROM intake_requests WHERE id=?', (rid,)).fetchone()
            self.assertEqual(json.loads(raw), answers)
            self.assertEqual(json.loads(schema), original_schema)
            self.assertEqual(card, converted_id)
            self.assertEqual(connection.execute('SELECT count(*) FROM sprint_cards WHERE sprint_id=?', (sid,)).fetchone()[0], 2)
            self.assertEqual(connection.execute('SELECT count(*) FROM sprint_snapshots WHERE sprint_id=?', (sid,)).fetchone()[0], 1)

    @unittest.skipUnless(os.environ.get('OPENBOARD_CLOUD_MIGRATION_TEST') == '1',
                         'Set OPENBOARD_CLOUD_MIGRATION_TEST=1 only for disposable stores')
    def test_schema_five_upgrade_preserves_document_references_and_rolls_back_failed_hydration(self):
        # These opt-in tests require disposable stores, as documented above.
        board = self.new_board()
        card_id = self.api('POST', f'/api/columns/{board["columns"][0]["id"]}/cards',
            {'title': self.name, 'checklist': [{'id': 'preserve', 'text': 'Caffè ☕', 'done': False}]}, expected=201)['id']
        original = self.api('GET', f'/api/cards/{card_id}')
        reference = self.stores.sql(f'SELECT checklist__doc FROM ob_cards WHERE id={card_id}')[0][0]
        for process, _, _, _ in self.processes:
            process.terminate()
            process.wait(timeout=15)
        self.stores.sql("DROP TABLE ob_review_votes,ob_review_members,ob_review_events,ob_reviews,ob_saved_reports,"
            "ob_sprint_cards,ob_sprint_capacity,ob_sprint_snapshots,ob_sprint_events,ob_sprints,"
            "ob_intake_fields,ob_intake_requests,ob_intake_notes,ob_intake_events,ob_intake_forms; "
            "DELETE FROM ob_sqlite_sequence WHERE name IN('reviews','review_events','saved_reports',"
            "'sprints','sprint_events','intake_forms','intake_fields','intake_requests','intake_notes','intake_events'); "
            "UPDATE ob_store SET schema_version=5; SELECT schema_version FROM ob_store")
        epoch = self.stores.sql('SELECT epoch FROM ob_store')[0][0]
        # A missing immutable document must abort both the new SQL layout and
        # the version change. Restore the original reference before retrying.
        self.stores.sql(f"UPDATE ob_cards SET checklist__doc='{'0' * 64}' WHERE id={card_id}; SELECT 1")
        environment = clean_environment()
        environment.update({k: os.environ[k] for k in ('OPENBOARD_POSTGRES_URL', 'OPENBOARD_MONGODB_URI')})
        try:
            result = subprocess.run([str(BINARY), '--db', str(Path(self.temp.name) / 'failed-upgrade.db'),
                '--no-demo', '--quiet'], env=environment, capture_output=True, timeout=25)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.stores.sql('SELECT schema_version,epoch FROM ob_store'), [['5', epoch]])
            self.assertEqual(self.stores.sql("SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='public' AND table_name IN('ob_reviews','ob_saved_reports')"), [])
        finally:
            self.stores.sql(f"UPDATE ob_cards SET checklist__doc='{reference}' WHERE id={card_id}; SELECT 1")
        recovered = self.start()
        self.assertEqual(self.api('GET', f'/api/cards/{card_id}', port=recovered), original)
        self.assertEqual(self.stores.sql('SELECT schema_version FROM ob_store'), [['7']])
        self.assertEqual(self.stores.sql(f'SELECT checklist__doc FROM ob_cards WHERE id={card_id}'), [[reference]])
        self.assertEqual(self.stores.sql('SELECT epoch FROM ob_store'), [[str(int(epoch) + 1)]])

    @unittest.skipUnless(os.environ.get('OPENBOARD_CLOUD_MONGO_CONTAINER'),
                         'Set an explicitly disposable MongoDB container for outage testing')
    def test_mongo_outage_rejects_write_and_retry_creates_once(self):
        container = os.environ['OPENBOARD_CLOUD_MONGO_CONTAINER']
        key = uuid.uuid4().hex
        subprocess.run(['docker','stop','--time','2',container],check=True,capture_output=True,timeout=20)
        try:
            self.assertEqual(self.request(self.first,'GET','/api/ready')[0],503)
            status, _, _ = self.request(self.first,'POST','/api/boards',{'name':self.name},key)
            self.assertEqual(status,503)
        finally:
            subprocess.run(['docker','start',container],check=True,capture_output=True,timeout=20)
        deadline = time.monotonic()+25
        while time.monotonic()<deadline:
            try:
                if self.request(self.first,'GET','/api/ready')[0]==200: break
            except OSError: pass
            time.sleep(.1)
        boards = self.api('GET','/api/boards')['boards']
        self.assertNotIn(self.name,[b['name'] for b in boards])
        created = self.api('POST','/api/boards',{'name':self.name},expected=201,key=key)
        replay = self.api('POST','/api/boards',{'name':self.name},expected=201,key=key)
        self.assertEqual(created,replay)
        self.assertEqual(sum(b['name']==self.name for b in self.api('GET','/api/boards')['boards']),1)


if __name__ == '__main__':
    unittest.main()
