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

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const prebuildSize = fs.statSync(
  path.join(root, 'prebuilds/linux-x64-musl/opcua_open62541.node')
).size;
const sourceSize = fs.statSync(
  path.join(root, 'vendor/open62541-v1.4.16.tar.gz')
).size;
if (!packageJson.files?.includes('prebuilds') || !packageJson.files?.includes('vendor')) {
  throw new Error('package.json files must include prebuilds and vendor for offline installation');
}
if (!packageJson.bundledDependencies?.includes('node-addon-api')) {
  throw new Error('node-addon-api must remain a bundled dependency');
}
if (prebuildSize < 100000 || sourceSize < 1000000) {
  throw new Error('Bundled native addon or open62541 source archive is unexpectedly small');
}

console.log(
  `Offline package inputs verified for ${packageJson.name}@${packageJson.version}: ` +
  `prebuild=${prebuildSize} bytes, open62541=${sourceSize} bytes`
);
