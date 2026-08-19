'use strict';

const path = require('node:path');
const { prebuildKey, resolvePrebuilt } = require('./prebuild');

let injectedAddon;
let loadedAddon;

function loadAddon() {
  if (injectedAddon) return injectedAddon;
  if (loadedAddon) return loadedAddon;

  const packageRoot = path.resolve(__dirname, '..');
  const candidates = [
    process.env.OPCUA_OPEN62541_ADDON,
    resolvePrebuilt(packageRoot),
    path.join(packageRoot, 'build', 'Release', 'opcua_open62541.node'),
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      loadedAddon = require(candidate);
      return loadedAddon;
    } catch (error) {
      lastError = error;
    }
  }

  const wrapped = new Error(
    `Native open62541 addon is unavailable for ${prebuildKey()}: ` +
    `${lastError?.message || 'no addon candidate found'}. ` +
    'Run npm run build:offline-prebuild to build this platform.'
  );
  wrapped.cause = lastError;
  throw wrapped;
}

function setAddonForTests(addon) {
  injectedAddon = addon;
}

function resetAddonForTests() {
  injectedAddon = undefined;
  loadedAddon = undefined;
}

module.exports = { loadAddon, setAddonForTests, resetAddonForTests };
