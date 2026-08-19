'use strict';

const { OpcUaClient, discoverEndpoints } = require('../lib/client');

function pathList(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/\r?\n|;/);
  return source.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function clientOptions(config, credentials = {}) {
  return {
    endpoint: config.endpoint,
    securityMode: config.securityMode || 'None',
    securityPolicy: config.securityPolicy || 'None',
    user: config.user || '',
    password: credentials.password || '',
    certificate: config.certificate || '',
    privateKey: config.privateKey || '',
    privateKeyPassword: credentials.privateKeyPassword || '',
    applicationUri: config.applicationUri || '',
    trustedCertificates: pathList(config.trustedCertificates),
    revocationList: pathList(config.revocationList),
    requestedSessionTimeout: Number(config.requestedSessionTimeout) || 60000,
    requestTimeout: Number(config.requestTimeout) || 10000,
    connectivityCheckInterval: Number.isFinite(Number(config.connectivityCheckInterval))
      ? Math.max(0, Math.floor(Number(config.connectivityCheckInterval)))
      : 5000,
    reconnectInterval: Number(config.reconnectInterval) || 5000,
    maxReconnectInterval: Number(config.maxReconnectInterval) || 30000,
    nodeIdCacheSize: Number.isFinite(Number(config.nodeIdCacheSize))
      ? Math.max(0, Math.floor(Number(config.nodeIdCacheSize)))
      : 100000,
    commandQueueSize: Number.isFinite(Number(config.commandQueueSize))
      ? Math.max(1, Math.floor(Number(config.commandQueueSize)))
      : 256,
  };
}

module.exports = function registerConnectionNode(RED) {
  RED.httpAdmin.post(
    '/opcua-client/endpoints',
    RED.auth.needsPermission('opcua-client.discovery'),
    async (req, res) => {
      try {
        const endpoints = await discoverEndpoints({
          endpoint: req.body?.endpoint,
          requestTimeout: req.body?.requestTimeout,
        });
        res.send({ endpoints });
      } catch (error) {
        res.status(error?.code === 'OPCUA_RECONNECTING' ? 503 : 400).send({
          error: error.message || String(error),
          code: error.code || 'OPCUA_DISCOVERY_FAILED',
        });
      }
    }
  );

  RED.httpAdmin.post(
    '/opcua-client/test-connection',
    RED.auth.needsPermission('opcua-client.test'),
    async (req, res) => {
      const body = req.body || {};
      const deployed = body.connectionId ? RED.nodes.getNode(String(body.connectionId)) : null;
      const deployedOptions = deployed?.client?.options || {};
      const suppliedPassword = body.password && body.password !== '__PWRD__'
        ? String(body.password) : deployedOptions.password;
      const suppliedPrivateKeyPassword = body.privateKeyPassword &&
        body.privateKeyPassword !== '__PWRD__'
        ? String(body.privateKeyPassword) : deployedOptions.privateKeyPassword;
      const options = {
        ...deployedOptions,
        ...clientOptions(body, {
          password: suppliedPassword,
          privateKeyPassword: suppliedPrivateKeyPassword,
        }),
      };
      const client = new OpcUaClient(options);
      client.on('fault', () => {});
      try {
        await client.connect();
        const diagnostics = client.getDiagnostics();
        const state = client.getState();
        await client.disconnect();
        res.send({
          connected: true,
          state,
          connection: diagnostics.connection || {},
          operationLimits: diagnostics.operationLimits || {},
        });
      } catch (error) {
        try { await client.disconnect(); } catch {}
        res.status(400).send({
          connected: false,
          error: error.message || String(error),
          code: error.code || 'OPCUA_CONNECTION_TEST_FAILED',
        });
      }
    }
  );

  function OpcUaConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.client = new OpcUaClient(clientOptions(config, node.credentials));

    node.client.on('fault', (error) => node.warn(`OPC UA connection fault: ${error.message}`));
    node.client.on('state', (state) => {
      if (state.state === 'failed') node.warn(`OPC UA connection failed: ${state.statusCode}`);
    });
    node.on('close', async (done) => {
      try {
        await node.client.disconnect();
      } catch (error) {
        node.warn(`OPC UA disconnect failed: ${error.message}`);
      }
      done();
    });
  }

  RED.nodes.registerType('tier0-opcua-connection', OpcUaConnectionNode, {
    credentials: {
      password: { type: 'password' },
      privateKeyPassword: { type: 'password' },
    },
  });
};
