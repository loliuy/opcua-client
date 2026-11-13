'use strict';

const COMPATIBILITY_PROFILES = Object.freeze({
  Standard: 'standard',
  SiemensWinCC: 'siemens-wincc',
});

const SIEMENS_WINCC_DEFAULTS = Object.freeze({
  requestBatchSize: 200,
  monitoredItemsPerSubscription: 1000,
});

function normalizeCompatibilityProfile(value) {
  return value === COMPATIBILITY_PROFILES.SiemensWinCC
    ? COMPATIBILITY_PROFILES.SiemensWinCC
    : COMPATIBILITY_PROFILES.Standard;
}

function isSiemensWinCC(value) {
  return normalizeCompatibilityProfile(value) === COMPATIBILITY_PROFILES.SiemensWinCC;
}

module.exports = {
  COMPATIBILITY_PROFILES,
  SIEMENS_WINCC_DEFAULTS,
  isSiemensWinCC,
  normalizeCompatibilityProfile,
};
