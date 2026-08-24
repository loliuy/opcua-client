'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prebuildKey, resolvePrebuilt } = require('../lib/prebuild');

const packageRoot = path.resolve(__dirname, '..');
const prebuilt = resolvePrebuilt(packageRoot);

if (prebuilt && process.env.OPCUA_CLIENT_FORCE_BUILD !== '1') {
  console.log(`Using bundled OPC UA native addon for ${prebuildKey()}`);
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`No bundled native addon for ${prebuildKey()}; building from bundled source`);
run('bash', ['scripts/build-open62541.sh']);
run('node-gyp', ['rebuild']);
