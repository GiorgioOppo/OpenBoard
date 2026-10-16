/* npm's latest release still bundles these older libraries. Replace their
 * real code using integrity-checked upstream artifacts, then rebuild the lock
 * from the installed runtime tree. Preserve npm's upstream dev/workspace data:
 * those source-only workspaces are not distributed in the global CLI package. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const directory = '/usr/lib/node_modules/npm';
const require = createRequire(`${directory}/package.json`);
const application = JSON.parse(fs.readFileSync(`${directory}/package.json`, 'utf8'));
assert.equal(application.version, '12.2.0');
const pacote = require('pacote');
const Arborist = require('@npmcli/arborist');
const patches = {
  'brace-expansion': {
    version: '5.0.12',
    url: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz',
    integrity: 'sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==',
  },
  'undici': {
    version: '6.28.1',
    url: 'https://registry.npmjs.org/undici/-/undici-6.28.1.tgz',
    integrity: 'sha512-zWpdTVD54H48CIybL0rWQ3ukpb9d23wM7eH5RtfdmeP70cWHNjtfo7P4vZX+5CoDcO53J4Pu5uXp7lNfjc6DRA==',
  },
  'http-cache-semantics': {
    version: '4.3.0',
    url: 'https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.3.0.tgz',
    integrity: 'sha512-M5t5LlJpS1UHMjvwRQVdFHvPISGeLAxNcrWuJkeGh0KxsqCHZ1O3NXZU/8x7cD0BDcGW8kapxMKTvwlqrNkHkA==',
  },
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openboard-npm-bundle-'));
try {
  for (const [name, patch] of Object.entries(patches)) {
    const target = path.join(temporary, name);
    await pacote.extract(patch.url, target, {integrity: patch.integrity, cache: path.join(temporary, 'cache')});
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, patch.version);
  }
  application.overrides = {...application.overrides};
  for (const [name, patch] of Object.entries(patches)) {
    fs.rmSync(path.join(directory, 'node_modules', name), {recursive: true});
    fs.renameSync(path.join(temporary, name), path.join(directory, 'node_modules', name));
    application.overrides[name] = patch.version;
  }
  fs.writeFileSync(`${directory}/package.json`, `${JSON.stringify(application, null, 2)}\n`);
  const tree = await new Arborist({path: directory, workspacesEnabled: false})
    .loadActual({forceActual: true, ignoreMissing: true});
  for (const [name, patch] of Object.entries(patches)) {
    const node = tree.children.get(name);
    assert.equal(node.version, patch.version);
    node.resolved = patch.url;
    node.integrity = patch.integrity;
  }
  for (const node of tree.inventory.values()) tree.meta.add(node);
  await tree.meta.save();
  const lock = JSON.parse(fs.readFileSync(`${directory}/package-lock.json`, 'utf8'));
  for (const [name, patch] of Object.entries(patches)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, patch.version);
    assert.equal(lock.packages[`node_modules/${name}`].integrity, patch.integrity);
  }
  fs.writeFileSync(`${directory}/OPENBOARD_PATCHES.json`, `${JSON.stringify(patches, null, 2)}\n`);
  console.log('npm bundled code and runtime lock updated: brace-expansion 5.0.12, undici 6.28.1, http-cache-semantics 4.3.0');
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
