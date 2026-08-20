'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_SECURITY_FILE_SIZE = 2 * 1024 * 1024;

const FILE_KINDS = Object.freeze({
  clientCertificate: {
    prefix: 'client-certificate',
    extensions: new Set(['.der', '.pem', '.crt', '.cer']),
  },
  privateKey: {
    prefix: 'client-private-key',
    extensions: new Set(['.der', '.pem', '.key']),
  },
  trustedCertificate: {
    prefix: 'trusted-certificate',
    extensions: new Set(['.der', '.pem', '.crt', '.cer']),
  },
  revocationList: {
    prefix: 'revocation-list',
    extensions: new Set(['.der', '.pem', '.crl']),
  },
});

function storageError(message, code = 'OPCUA_SECURITY_FILE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeBase64(value) {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw storageError('Security file content must be valid base64');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.length || decoded.toString('base64') !== encoded) {
    throw storageError('Security file content must be valid base64');
  }
  return decoded;
}

function connectionDirectoryName(connectionId) {
  const value = String(connectionId || '').trim();
  if (!value || value.length > 256) {
    throw storageError('A valid Connection node id is required');
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

class SecurityFileStore {
  constructor(options = {}) {
    const userDir = path.resolve(String(options.userDir || process.cwd()));
    this.root = path.join(userDir, 'opcua-pki');
    this.maxFileSize = Number(options.maxFileSize) || MAX_SECURITY_FILE_SIZE;
  }

  connectionDirectory(connectionId) {
    return path.join(this.root, connectionDirectoryName(connectionId));
  }

  async save({ connectionId, kind, fileName, contentBase64 }) {
    const definition = FILE_KINDS[kind];
    if (!definition) throw storageError(`Unsupported OPC UA security file kind: ${kind}`);

    const extension = path.extname(String(fileName || '')).toLowerCase();
    if (!definition.extensions.has(extension)) {
      throw storageError(
        `Unsupported ${kind} file extension; allowed: ${[...definition.extensions].join(', ')}`
      );
    }

    const content = decodeBase64(contentBase64);
    if (content.length > this.maxFileSize) {
      throw storageError(
        `Security file exceeds the ${this.maxFileSize} byte limit`,
        'OPCUA_SECURITY_FILE_TOO_LARGE'
      );
    }

    const directory = this.connectionDirectory(connectionId);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const managedName = `${definition.prefix}-${sha256.slice(0, 24)}${extension}`;
    const managedPath = path.join(directory, managedName);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(managedPath, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await fs.chmod(managedPath, 0o600);

    return {
      kind,
      name: path.basename(String(fileName || '')),
      path: managedPath,
      size: content.length,
      sha256,
      managed: true,
    };
  }

  async removeConnection(connectionId) {
    const directory = this.connectionDirectory(connectionId);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  FILE_KINDS,
  MAX_SECURITY_FILE_SIZE,
  SecurityFileStore,
  connectionDirectoryName,
  decodeBase64,
};
