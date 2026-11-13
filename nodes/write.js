'use strict';

const { createDiagnostics } = require('../lib/diagnostics');

const { messageWritePoints } = require('../lib/points');

module.exports = function registerWriteNode(RED) {
  function OpcUaWriteNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);
    const diagnostics = createDiagnostics(node, config, 'write');
    const consumer = node.connection?.registerConsumer?.('write', {
      nodeId: config.id, name: config.name,
    });

    node.on('input', async (msg, send, done) => {
      if (!node.connection) {
        const error = new Error('OPCUA_CONNECTION_NOT_CONFIGURED');
        diagnostics.failure(error, send);
        return done(error);
      }

      diagnostics.beginInput();
      let inputError;
      try {
        consumer?.markUsed('write');
        const points = messageWritePoints(msg, config);
        node.status({ fill: 'blue', shape: 'dot', text: `writing ${points.length}` });
        const results = await node.connection.client.writeMany(
          points,
          Number(config.batchSize) || 500
        );

        const failed = diagnostics.results(results, send, new Map(points.map((point) => [point.nodeId, point])));
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

        node.status({ fill: failed ? 'yellow' : 'green', shape: failed ? 'ring' : 'dot',
          text: `${results.length - failed}/${results.length} written` + (failed ? ` / ${failed} failed` : '') });
        done();
      } catch (error) {
        inputError = error;
        node.status({ fill: 'red', shape: 'ring', text: error.message });
        diagnostics.failure(error, send);
        done(error);
      } finally {
        diagnostics.endInput(inputError);
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
