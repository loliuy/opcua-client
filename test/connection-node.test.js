'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registerConnectionNode = require('../nodes/connection');
const { setAddonForTests, resetAddonForTests } = require('../lib/native');

test.afterEach(() => resetAddonForTests());

function createHarness() {
  const routes = new Map();
  let Constructor;
  const RED = {
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
        node.warn = () => {};
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
