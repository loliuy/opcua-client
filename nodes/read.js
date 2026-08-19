'use strict';

const { looksLikePointList, messagePoints } = require('../lib/points');

module.exports = function registerReadNode(RED) {
  function OpcUaReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);

    node.on('input', async (msg, send, done) => {
      if (!node.connection) return done(new Error('OPC UA connection not configured'));

      try {
        const points = messagePoints(msg, config.nodeId, {
          indexRange: config.indexRange,
        }, {
          configuredPayload: config.pointList,
          format: 'auto',
        });
        node.status({ fill: 'blue', shape: 'dot', text: `reading ${points.length}` });
        const values = await node.connection.client.readMany(
          points,
          Number(config.batchSize) || 500
        );
        const descriptors = new Map(points.map((point) => [point.nodeId, point]));
        const results = values.map((value) => ({
          ...descriptors.get(value.nodeId),
          ...value,
        }));

        if ((config.outputMode || 'batch') === 'split') {
          results.forEach((result) => send({
            ...msg,
            topic: result.nodeId,
            payload: result.value,
            opcua: result,
          }));
        } else if (points.length === 1 && !looksLikePointList(msg.payload) &&
                   !Array.isArray(msg.items) && !config.pointList) {
          const result = results[0];
          msg.topic = result.nodeId;
          msg.payload = result.value;
          msg.opcua = result;
          send(msg);
        } else {
          msg.payload = results;
          msg.opcua = {
            ...(msg.opcua || {}),
            operation: 'read',
            total: results.length,
            good: results.filter((item) => item.statusCode === 'Good').length,
            clientDiagnostics: node.connection.client.getDiagnostics(),
          };
          send(msg);
        }

        node.status({ fill: 'green', shape: 'dot', text: `${results.length} read` });
        done();
      } catch (error) {
        node.status({ fill: 'red', shape: 'ring', text: error.message });
        done(error);
      }
    });
  }

  RED.nodes.registerType('tier0-opcua-read', OpcUaReadNode);
};
