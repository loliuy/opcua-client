'use strict';

let injectedAddon;
let loadedAddon;

function loadAddon() {
  if (injectedAddon) return injectedAddon;
  if (loadedAddon) return loadedAddon;

  try {
    loadedAddon = require('../build/Release/opcua_open62541.node');
    return loadedAddon;
  } catch (error) {
    const wrapped = new Error(
      `Native open62541 addon is unavailable: ${error.message}. ` +
      'Run npm run build:open62541 && npm run build.'
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function setAddonForTests(addon) {
  injectedAddon = addon;
}

function resetAddonForTests() {
  injectedAddon = undefined;
  loadedAddon = undefined;
}

module.exports = { loadAddon, setAddonForTests, resetAddonForTests };
