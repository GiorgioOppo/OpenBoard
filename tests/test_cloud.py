"""Real PostgreSQL/MongoDB persistence tests (opt in with OPENBOARD_CLOUD_TEST=1).

Use disposable databases in OPENBOARD_POSTGRES_URL/OPENBOARD_MONGODB_URI. The
suite adds uniquely named data, never drops databases. Driver inspection uses
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
