'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SecurityFileStore,
  connectionDirectoryName,
  decodeBase64,
} = require('../lib/security-file-store');

async function temporaryStore(t, options = {}) {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tier0-opcua-pki-'));
  t.after(() => fs.rm(userDir, { recursive: true, force: true }));
  return { store: new SecurityFileStore({ userDir, ...options }), userDir };
}

test('stores uploaded security files in a per-Connection managed directory', async (t) => {
  const { store, userDir } = await temporaryStore(t);
  const content = Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
  const request = {
    connectionId: 'abc.123',
    kind: 'clientCertificate',
    fileName: 'factory-client.pem',
    contentBase64: content.toString('base64'),
  };

  const first = await store.save(request);
  const second = await store.save(request);
  assert.equal(first.path, second.path);
  assert.equal(first.name, 'factory-client.pem');
  assert.equal(first.managed, true);
  assert.equal(first.size, content.length);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    path.dirname(first.path),
    path.join(userDir, 'opcua-pki', connectionDirectoryName('abc.123'))
  );
  assert.deepEqual(await fs.readFile(first.path), content);

  await store.removeConnection('abc.123');
  await assert.rejects(() => fs.access(first.path), /ENOENT/);
});

test('validates upload kind, extension, base64 and size', async (t) => {
  const { store } = await temporaryStore(t, { maxFileSize: 4 });
  const base = {
    connectionId: 'connection-1',
    kind: 'privateKey',
    fileName: 'client.key',
    contentBase64: Buffer.from('key').toString('base64'),
  };

  await assert.rejects(() => store.save({ ...base, kind: 'unknown' }), /Unsupported/);
  await assert.rejects(() => store.save({ ...base, fileName: 'client.txt' }), /extension/);
  await assert.rejects(() => store.save({ ...base, contentBase64: 'not base64' }), /valid base64/);
  await assert.rejects(
    () => store.save({ ...base, contentBase64: Buffer.from('large').toString('base64') }),
    (error) => error.code === 'OPCUA_SECURITY_FILE_TOO_LARGE'
  );
  await assert.rejects(() => store.save({ ...base, connectionId: '' }), /Connection node id/);
});

test('base64 decoder rejects non-canonical or empty input', () => {
  assert.deepEqual(decodeBase64(Buffer.from('abc').toString('base64')), Buffer.from('abc'));
  assert.throws(() => decodeBase64(''), /valid base64/);
  assert.throws(() => decodeBase64('YQ'), /valid base64/);
});
