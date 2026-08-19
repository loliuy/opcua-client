'use strict';

const { prebuildKey } = require('../lib/prebuild');
const { loadAddon } = require('../lib/native');

const addon = loadAddon();
const required = [
  'connectAsync',
  'disconnectAsync',
  'browseAsync',
  'readManyAsync',
  'writeManyAsync',
  'createSubscriptionAsync',
];
const missing = required.filter((name) => typeof addon[name] !== 'function');
if (missing.length) {
  throw new Error(`Native addon is missing exports: ${missing.join(', ')}`);
}

console.log(`Offline native addon loaded for ${prebuildKey()} on ${process.version}`);
