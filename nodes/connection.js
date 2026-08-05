'use strict';

const { OpcUaClient } = require('../lib/client');

module.exports = function registerConnectionNode(RED) {
  function OpcUaConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.client = new OpcUaClient({
      endpoint: config.endpoint,
      securityMode: config.securityMode || 'None',
      securityPolicy: config.securityPolicy || 'None',
      user: config.user || '',
      password: node.credentials?.password || '',
      certificate: config.certificate || '',
      privateKey: config.privateKey || '',
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
    });

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
    },
  });
};
