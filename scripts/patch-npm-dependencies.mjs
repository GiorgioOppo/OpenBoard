/* Pin only the reviewed upstream fixes; preserve NPM's application version. */
import fs from 'node:fs';

const path = '/app/package.json';
const application = JSON.parse(fs.readFileSync(path, 'utf8'));
if (application.version !== '2.16.0') throw new Error('Unexpected NPM base version');
application.resolutions = {
  ...application.resolutions,
  'proxy-addr': '2.0.8',
  'basic-ftp': '6.2.3',
  'brace-expansion': '5.0.12',
  '**/node-gyp/undici': '6.28.1',
};
fs.writeFileSync(path, `${JSON.stringify(application, null, 2)}\n`);
