'use strict';

const fs = require('node:fs');
const path = require('node:path');

function linuxLibc(report) {
  if (report?.header?.glibcVersionRuntime || report?.header?.glibcVersionCompiler) {
    return 'glibc';
  }
  return 'musl';
}

function runtimeReport() {
  try {
    return process.report?.getReport?.();
  } catch {
    return undefined;
  }
}

function prebuildKey(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== 'linux') return `${platform}-${arch}`;
  return `${platform}-${arch}-${linuxLibc(options.report || runtimeReport())}`;
}

function prebuildPath(packageRoot, options = {}) {
  return path.join(
    packageRoot,
    'prebuilds',
    prebuildKey(options),
    'opcua_open62541.node'
  );
}

function resolvePrebuilt(packageRoot, options = {}) {
  const candidate = prebuildPath(packageRoot, options);
  return fs.existsSync(candidate) ? candidate : undefined;
}

module.exports = { linuxLibc, prebuildKey, prebuildPath, resolvePrebuilt };
