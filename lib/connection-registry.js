'use strict';

const crypto = require('node:crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function connectionSignature(options) {
  const source = options || {};
  const identity = {
    endpoint: String(source.endpoint || '').trim(),
    securityMode: String(source.securityMode || 'None'),
    securityPolicy: String(source.securityPolicy || 'None'),
    user: String(source.user || '').trim(),
  };
  const serialized = JSON.stringify(canonicalize(identity));
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

class ConnectionRegistry {
  constructor() {
    this.entries = new Map();
    this.configurationCount = 0;
  }

  register(options) {
    const signature = connectionSignature(options);
    let records = this.entries.get(signature);
    if (!records) {
      records = new Set();
      this.entries.set(signature, records);
    }
    const record = {};
    records.add(record);
    this.configurationCount += 1;
    let unregistered = false;

    return {
      duplicate: records.size > 1,
      diagnostics: () => ({
        equivalentConfigurations: records.size,
        duplicateConfiguration: records.size > 1,
        activeConfigurations: this.configurationCount,
      }),
      unregister: () => {
        if (unregistered) return false;
        unregistered = true;
        records.delete(record);
        this.configurationCount = Math.max(0, this.configurationCount - 1);
        if (records.size === 0) this.entries.delete(signature);
        return true;
      },
    };
  }

  get size() {
    return this.configurationCount;
  }
}

module.exports = { ConnectionRegistry, connectionSignature };
