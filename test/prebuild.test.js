'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { linuxLibc, prebuildKey, prebuildPath } = require('../lib/prebuild');

test('detects glibc and musl Linux prebuild keys', () => {
  assert.equal(linuxLibc({ header: { glibcVersionRuntime: '2.36' } }), 'glibc');
  assert.equal(linuxLibc({ header: {} }), 'musl');
  assert.equal(prebuildKey({
    platform: 'linux', arch: 'x64', report: { header: { glibcVersionRuntime: '2.36' } },
  }), 'linux-x64-glibc');
  assert.equal(prebuildKey({
    platform: 'linux', arch: 'x64', report: { header: {} },
  }), 'linux-x64-musl');
});

test('uses platform and architecture for non-Linux prebuilds', () => {
  assert.equal(prebuildKey({ platform: 'win32', arch: 'x64' }), 'win32-x64');
  assert.equal(
    prebuildPath('/package', { platform: 'win32', arch: 'x64' }),
    path.join('/package', 'prebuilds', 'win32-x64', 'opcua_open62541.node')
  );
});
