"""Opt-in regression tests for the patched database images.

OPENBOARD_POSTGRES_IMAGE=openboard-postgres:security \
OPENBOARD_MONGO_IMAGE=openboard-mongo:security \
python3 -m unittest discover -s tests -p test_database_images.py -v

Only uniquely named containers with tmpfs databases are created. They publish
no ports, have no network access, and never attach existing Docker volumes.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


def docker(*args, environment=None, timeout=30):
    return subprocess.run(['docker', *args], env=environment, capture_output=True,
                          text=True, timeout=timeout)


class DatabaseImage:
    @classmethod
    def start(cls, image, arguments, variables, ready, command=()):
        cls.container = 'openboard-security-' + uuid.uuid4().hex
        cls.addClassCleanup(lambda: docker('rm', '--force', '--volumes', cls.container))
        environment = os.environ.copy()
        environment.update(variables)
        args = ['run', '--detach', '--network', 'none', '--name', cls.container]
        for name in variables:
            args += ['--env', name]
        result = docker(*args, *arguments, image, *command, environment=environment)
        if result.returncode:
            raise RuntimeError('Disposable database container could not start: ' + result.stderr)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if cls.exec(*ready).returncode == 0:
                return
            time.sleep(.15)
        # Do not print logs: database initialization output may contain secrets.
        raise RuntimeError('Disposable database did not become ready')

    @classmethod
    def exec(cls, *command):
        return docker('exec', cls.container, *command)


@unittest.skipUnless(os.environ.get('OPENBOARD_POSTGRES_IMAGE'),
                     'Set OPENBOARD_POSTGRES_IMAGE for disposable image tests')
class PostgresImage(DatabaseImage, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.start(os.environ['OPENBOARD_POSTGRES_IMAGE'], [
            '--tmpfs', '/var/lib/postgresql/data:rw,size=256m',
            '--mount', f'type=bind,src={ROOT / "scripts/postgres-init.sh"},dst=/docker-entrypoint-initdb.d/10-openboard.sh,readonly',
        ], {'POSTGRES_USER': 'postgres', 'POSTGRES_DB': 'openboard',
            'POSTGRES_PASSWORD': secrets.token_hex(24),
            'POSTGRES_APP_PASSWORD': secrets.token_hex(24),
            'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256'},
            ['sh', '-ec', 'PGPASSWORD="$POSTGRES_APP_PASSWORD" psql -h 127.0.0.1 -U openboard -d openboard -Atqc "SELECT 1"'])

    def test_server_privileges_and_password_authentication(self):
        self.assertIn('17.', self.exec('postgres', '--version').stdout)
        self.assertIn('go1.26.9', self.exec('gosu', '--version').stdout)
        result = self.exec('sh', '-ec', 'PGPASSWORD="$POSTGRES_APP_PASSWORD" psql -h 127.0.0.1 -U openboard -d openboard -Atqc "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'f|f|f|f')
        self.assertNotEqual(self.exec('sh', '-ec', 'PGPASSWORD=wrong psql -h 127.0.0.1 -U openboard -d openboard -Atqc "SELECT 1"').returncode, 0)

    def test_backup_restore_retains_unicode_json_and_constraints(self):
        result = self.exec('sh', '-ec', '''
export PGPASSWORD="$POSTGRES_APP_PASSWORD"
psql -h 127.0.0.1 -U openboard -d openboard -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE image_roundtrip (id integer PRIMARY KEY, title text NOT NULL, details jsonb NOT NULL);
INSERT INTO image_roundtrip VALUES (7, '日本語 · Español', '{"budget": 0}');
SQL
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.exec('sh', '-ec', '''
export PGPASSWORD="$POSTGRES_APP_PASSWORD"
pg_dump -h 127.0.0.1 -U openboard -d openboard --format=custom --file=/tmp/roundtrip.dump
psql -h 127.0.0.1 -U openboard -d openboard -v ON_ERROR_STOP=1 -c 'DROP TABLE image_roundtrip'
pg_restore -h 127.0.0.1 -U openboard -d openboard --exit-on-error /tmp/roundtrip.dump
psql -h 127.0.0.1 -U openboard -d openboard -Atqc 'SELECT row_to_json(image_roundtrip) FROM image_roundtrip'
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(record, {'id': 7, 'title': '日本語 · Español', 'details': {'budget': 0}})
        duplicate = self.exec('sh', '-ec', '''
export PGPASSWORD="$POSTGRES_APP_PASSWORD"
psql -h 127.0.0.1 -U openboard -d openboard -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO image_roundtrip VALUES (7, 'duplicate', '{}');
SQL
''')
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn('duplicate key', duplicate.stderr)


@unittest.skipUnless(os.environ.get('OPENBOARD_MONGO_IMAGE'),
                     'Set OPENBOARD_MONGO_IMAGE for disposable image tests')
class MongoImage(DatabaseImage, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory(prefix='openboard-security-mongo-')
        cls.addClassCleanup(folder.cleanup)
        config = Path(folder.name) / 'mongod.yaml'
        config.write_text('storage:\n  dbPath: /data/db\nnet:\n  bindIp: 127.0.0.1\n  port: 27017\n')
        cls.start(os.environ['OPENBOARD_MONGO_IMAGE'], [
            '--tmpfs', '/data/db:rw,size=512m', '--tmpfs', '/data/configdb:rw,size=16m',
            '--mount', f'type=bind,src={ROOT / "scripts/mongo-init.js"},dst=/docker-entrypoint-initdb.d/10-openboard.js,readonly',
            '--mount', f'type=bind,src={config},dst=/etc/openboard-mongod.yaml,readonly',
        ], {'MONGO_INITDB_ROOT_USERNAME': 'root',
            'MONGO_INITDB_ROOT_PASSWORD': secrets.token_hex(24),
            'MONGO_INITDB_DATABASE': 'openboard',
            'OPENBOARD_MONGO_APP_PASSWORD': secrets.token_hex(24)},
            ['mongosh', '--quiet', '--eval', 'if (!db.getSiblingDB("openboard").auth("openboard", process.env.OPENBOARD_MONGO_APP_PASSWORD)) quit(1)'],
            command=['mongod', '--config', '/etc/openboard-mongod.yaml'])

    def test_tools_authentication_and_yaml_bundle(self):
        self.assertIn('go1.26.9', self.exec('gosu', '--version').stdout)
        self.assertIn('v8.0.', self.exec('mongod', '--version').stdout)
        for tool in ['bsondump', 'mongodump', 'mongorestore', 'mongoimport',
                     'mongoexport', 'mongostat', 'mongotop', 'mongofiles']:
            with self.subTest(tool=tool):
                result = self.exec(tool, '--version')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('go1.26.9', result.stdout)
        result = self.exec('mongosh', '--quiet', '--nodb', '--eval', 'load("/js-yaml.js"); const config = jsyaml.load("net:\\n  port: 27017\\n"); if (config.net.port !== 27017) quit(1)')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(self.exec('mongosh', '--quiet', '--eval', 'db.getSiblingDB("openboard").auth("openboard", "wrong")').returncode, 0)

    def test_backup_restore_retains_json_types_and_unicode(self):
        result = self.exec('mongosh', '--quiet', '--eval', 'db.getSiblingDB("openboard").auth("openboard", process.env.OPENBOARD_MONGO_APP_PASSWORD); db.getSiblingDB("openboard").image_roundtrip.insertOne({_id: 7, title: "日本語 · Español", budget: 0, urgent: false, context: {items: ["原文", null]}})')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.exec('sh', '-ec', '''
mongodump --host 127.0.0.1 --username openboard --password "$OPENBOARD_MONGO_APP_PASSWORD" --authenticationDatabase openboard --db openboard --collection image_roundtrip --archive=/tmp/roundtrip.archive
mongosh --quiet --eval 'db.getSiblingDB("openboard").auth("openboard", process.env.OPENBOARD_MONGO_APP_PASSWORD); db.getSiblingDB("openboard").image_roundtrip.drop()'
mongorestore --host 127.0.0.1 --username openboard --password "$OPENBOARD_MONGO_APP_PASSWORD" --authenticationDatabase openboard --archive=/tmp/roundtrip.archive
mongosh --quiet --eval 'db.getSiblingDB("openboard").auth("openboard", process.env.OPENBOARD_MONGO_APP_PASSWORD); print(JSON.stringify(db.getSiblingDB("openboard").image_roundtrip.findOne({_id: 7})))'
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]), {
            '_id': 7, 'title': '日本語 · Español', 'budget': 0, 'urgent': False,
            'context': {'items': ['原文', None]}})
