'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = [
  'vendor/open62541-v1.4.16.tar.gz',
  'vendor/open62541-LICENSE',
  'prebuilds/linux-x64-musl/opcua_open62541.node',
  'node_modules/node-addon-api/package.json',
];
const missing = required.filter((entry) => !fs.existsSync(path.join(root, entry)));

if (missing.length) {
  console.error(`Offline package is incomplete:\n- ${missing.join('\n- ')}`);
  process.exit(1);
}

console.log('Offline package inputs verified');
