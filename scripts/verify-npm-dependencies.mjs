/* Build-time and standalone runtime checks for the patched NPM dependency tree. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

assert.equal(process.versions.node, '22.23.4', 'NPM Node.js runtime');
const require = createRequire('/app/package.json');
for (const [path, version] of [
  ['/app/package.json', '2.16.0'],
  ['/app/node_modules/proxy-addr/package.json', '2.0.8'],
  ['/app/node_modules/basic-ftp/package.json', '6.2.3'],
  ['/app/node_modules/brace-expansion/package.json', '5.0.12'],
  ['/app/node_modules/node-gyp/node_modules/undici/package.json', '6.29.1'],
  ['/usr/lib/node_modules/npm/package.json', '12.2.1'],
  ['/usr/lib/node_modules/npm/node_modules/brace-expansion/package.json', '5.0.12'],
  ['/usr/lib/node_modules/npm/node_modules/undici/package.json', '6.29.1'],
  ['/usr/lib/node_modules/npm/node_modules/http-cache-semantics/package.json', '4.3.0'],
]) assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).version, version, path);

const bcrypt = require('bcrypt');
assert(bcrypt.compareSync('OpenBoard fixture', bcrypt.hashSync('OpenBoard fixture', 4)));
assert(!bcrypt.compareSync('wrong', bcrypt.hashSync('OpenBoard fixture', 4)));
const database = new (require('better-sqlite3'))(':memory:');
assert.deepEqual(database.prepare('SELECT 1 AS number').get(), {number: 1});
database.close();
await new Promise((resolve, reject) => {
  const sqlite = new (require('sqlite3').Database)(':memory:');
  sqlite.get('SELECT 1 AS number', (error, row) => {
    if (error) return reject(error);
    try { assert.deepEqual(row, {number: 1}); } catch (failure) { return reject(failure); }
    sqlite.close(error => error ? reject(error) : resolve());
  });
});

const proxyAddress = require('proxy-addr');
assert.equal(proxyAddress({socket: {remoteAddress: '127.0.0.1'}, headers: {'x-forwarded-for': '192.0.2.7'}},
                          proxyAddress.compile('loopback')), '192.0.2.7');
assert(require('minimatch').minimatch('release-en', 'release-{en,fr}'));
const ftp = new (require('basic-ftp').Client)();
ftp.close();
const {getUri} = await import(require.resolve('get-uri'));
const content = await getUri('data:text/plain;base64,T3BlbkJvYXJk');
let text = '';
for await (const chunk of content) text += chunk;
assert.equal(text, 'OpenBoard');
const npmRequire = createRequire('/usr/lib/node_modules/npm/package.json');
const CachePolicy = npmRequire('http-cache-semantics');
const request = {url: 'https://registry.npmjs.org/fixture', method: 'GET', headers: {}};
const policy = new CachePolicy(request, {status: 200, headers: {'cache-control': 'public, max-age=60'}});
assert(policy.storable());
assert(policy.satisfiesWithoutRevalidation(request));
assert(CachePolicy.fromObject(policy.toObject()).satisfiesWithoutRevalidation(request));
console.log('NPM dependencies: pins, native hashing/SQLite, proxy IP parsing, glob and URI APIs OK');
