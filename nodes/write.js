'use strict';

const { messageWritePoints } = require('../lib/points');

module.exports = function registerWriteNode(RED) {
  function OpcUaWriteNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);
    const consumer = node.connection?.registerConsumer?.('write', {
      nodeId: config.id, name: config.name,
    });

    node.on('input', async (msg, send, done) => {
      if (!node.connection) return done(new Error('OPC UA connection not configured'));

      try {
        consumer?.markUsed('write');
        const points = messageWritePoints(msg, config);
        node.status({ fill: 'blue', shape: 'dot', text: `writing ${points.length}` });
        const results = await node.connection.client.writeMany(
          points,
          Number(config.batchSize) || 500
        );

        if ((config.outputMode || 'batch') === 'split') {
          results.forEach((result) => send({ ...msg, topic: result.nodeId, opcua: result }));
        } else {
          msg.payload = results;
          msg.opcua = {
            ...(msg.opcua || {}),
            operation: 'write',
            total: results.length,
            good: results.filter((item) => item.statusCode === 'Good').length,
            clientDiagnostics: node.connection.getDiagnostics?.() ||
              node.connection.client.getDiagnostics(),
          };
          send(msg);
        }

        node.status({ fill: 'green', shape: 'dot', text: `${results.length} written` });
        done();
      } catch (error) {
        node.status({ fill: 'red', shape: 'ring', text: error.message });
        done(error);
      }
    });

    node.on('close', (removed, done) => {
      if (typeof removed === 'function') done = removed;
      consumer?.release();
      done?.();
    });
  }

  RED.nodes.registerType('tier0-opcua-write', OpcUaWriteNode);
};
