'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const registerConnectionNode = require('../nodes/connection');
const { setAddonForTests, resetAddonForTests } = require('../lib/native');

test.afterEach(() => resetAddonForTests());

function createHarness(options = {}) {
  const routes = new Map();
  let Constructor;
  const RED = {
    settings: { userDir: options.userDir || process.cwd() },
    auth: { needsPermission: (permission) => permission },
    httpAdmin: {
      post(path, permission, handler) {
        routes.set(path, { permission, handler });
      },
    },
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.warnings = [];
        node.warn = (message) => node.warnings.push(String(message));
        node.credentials = {};
      },
      getNode: () => null,
      registerType(name, constructor) {
        assert.equal(name, 'tier0-opcua-connection');
        Constructor = constructor;
      },
    },
  };
  registerConnectionNode(RED);
  return { Constructor, routes };
}

async function invoke(route, body) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, payload });
      },
    };
    Promise.resolve(route.handler({ body }, response)).catch(reject);
  });
}

async function closeNode(node) {
  await new Promise((resolve) => node.emit('close', resolve));
}

async function removeNode(node) {
  await new Promise((resolve) => node.emit('close', true, resolve));
}

test('uploads security files into Node-RED managed storage and cleans them on removal', async (t) => {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tier0-opcua-route-'));
  t.after(() => fs.rm(userDir, { recursive: true, force: true }));
  const harness = createHarness({ userDir });
  setAddonForTests({ disconnectAsync: async () => {} });
  const content = Buffer.from('managed private key');
  const route = harness.routes.get('/opcua-client/security-files');
  assert.equal(route.permission, 'opcua-client.security-files.write');

  const response = await invoke(route, {
    connectionId: 'connection-upload-test',
    kind: 'privateKey',
    fileName: 'client.key',
    contentBase64: content.toString('base64'),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.file.managed, true);
  assert.deepEqual(await fs.readFile(response.payload.file.path), content);

  const invalid = await invoke(route, {
    connectionId: 'connection-upload-test',
    kind: 'privateKey',
    fileName: 'client.txt',
    contentBase64: content.toString('base64'),
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.payload.code, 'OPCUA_SECURITY_FILE_INVALID');

  const node = new harness.Constructor({
    id: 'connection-upload-test',
    endpoint: 'opc.tcp://server:4840',
    securityMode: 'None',
    securityPolicy: 'None',
  });
  await removeNode(node);
  await assert.rejects(() => fs.access(response.payload.file.path), /ENOENT/);
});

test('registers endpoint discovery and secure connection test routes', async () => {
  const harness = createHarness();
  let connectOptions;
  let disconnects = 0;
  setAddonForTests({
    discoverEndpointsAsync: async () => [{
      endpointUrl: 'opc.tcp://secure:4840',
      securityMode: 'SignAndEncrypt',
      securityPolicyUri: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
      userIdentityTokens: [{ tokenType: 'Username' }],
    }],
    connectAsync: async (options) => {
      connectOptions = options;
      return 71;
    },
    getClientDiagnostics: () => ({
      connection: {
        connected: true,
        securityMode: 'SignAndEncrypt',
        securityPolicyUri: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
      },
      operationLimits: {},
    }),
    disconnectAsync: async () => { disconnects += 1; },
  });

  const discovery = await invoke(harness.routes.get('/opcua-client/endpoints'), {
    endpoint: 'opc.tcp://secure:4840',
  });
  assert.equal(discovery.statusCode, 200);
  assert.equal(discovery.payload.endpoints.length, 1);

  const connection = await invoke(harness.routes.get('/opcua-client/test-connection'), {
    endpoint: 'opc.tcp://secure:4840',
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Basic256Sha256',
    user: 'operator',
    password: 'secret',
    certificate: '/pki/client.der',
    privateKey: '/pki/client-key.pem',
    privateKeyPassword: 'key-secret',
    trustedCertificates: '/pki/server.der\n/pki/ca.der',
  });
  assert.equal(connection.statusCode, 200);
  assert.equal(connection.payload.connected, true);
  assert.equal(connectOptions.user, 'operator');
  assert.equal(connectOptions.password, 'secret');
  assert.equal(connectOptions.privateKeyPassword, 'key-secret');
  assert.deepEqual(connectOptions.trustedCertificates, ['/pki/server.der', '/pki/ca.der']);
  assert.equal(disconnects, 1);
});

test('one Connection config owns one client and equivalent configs are diagnosed, not merged', async () => {
  const harness = createHarness();
  let connects = 0;
  let disconnects = 0;
  setAddonForTests({
    connectAsync: async () => {
      connects += 1;
      return 80 + connects;
    },
    disconnectAsync: async () => { disconnects += 1; },
  });

  const config = {
    endpoint: 'opc.tcp://wincc:4862',
    securityMode: 'None',
    securityPolicy: 'None',
    reconnectInterval: 5000,
  };
  const first = new harness.Constructor({ ...config, name: 'Line A' });
  const second = new harness.Constructor({ ...config, name: 'Line B' });

  assert.notEqual(first.client, second.client);
  assert.deepEqual(second.getConnectionGovernance(), {
    equivalentConfigurations: 2,
    duplicateConfiguration: true,
    activeConfigurations: 2,
    allowParallelSession: false,
  });
  assert.match(second.warnings[0], /additional Session/);
  assert.equal(first.client.listenerCount('fault'), 1);
  assert.equal(second.client.listenerCount('fault'), 1);

  await first.client.connect();
  await first.client.connect();
  await second.client.connect();
  assert.equal(connects, 2);

  await closeNode(first);
  assert.equal(disconnects, 1);
  assert.deepEqual(second.getConnectionGovernance(), {
    equivalentConfigurations: 1,
    duplicateConfiguration: false,
    activeConfigurations: 1,
    allowParallelSession: false,
  });
  assert.equal(first.client.listenerCount('fault'), 0);

  await closeNode(second);
  assert.equal(disconnects, 2);
  assert.equal(second.client.listenerCount('fault'), 0);
});

test('explicit parallel Session setting suppresses the duplicate warning without merging clients', async () => {
  const harness = createHarness();
  setAddonForTests({ disconnectAsync: async () => {} });
  const config = {
    endpoint: 'opc.tcp://wincc:4862',
    securityMode: 'None',
    securityPolicy: 'None',
  };
  const first = new harness.Constructor(config);
  const second = new harness.Constructor({ ...config, allowParallelSession: true });

  assert.notEqual(first.client, second.client);
  assert.equal(second.warnings.length, 0);
  assert.equal(second.getConnectionGovernance().allowParallelSession, true);
  await closeNode(first);
  await closeNode(second);
});
