'use strict';

const { createDiagnostics } = require('../lib/diagnostics');

const { looksLikePointList, messagePoints } = require('../lib/points');

const COMPACT_RESULT_FIELDS = Object.freeze([
  'nodeId',
  'alias',
  'value',
  'statusCode',
  'sourceTimestamp',
]);

function compactResult(result) {
  const output = {};
  for (const field of COMPACT_RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(result, field)) output[field] = result[field];
  }
  return output;
}

function valueOnly(result) {
  return Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null;
}

module.exports = function registerReadNode(RED) {
  function OpcUaReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);
    const diagnostics = createDiagnostics(node, config, 'read');
    const consumer = node.connection?.registerConsumer?.('read', {
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
        consumer?.markUsed('read');
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

        // Undefined preserves the original output for Flow JSON created before
        // resultDetail was introduced. New editor nodes explicitly save compact.
        const failed = diagnostics.results(results, send);
        const resultDetail = config.resultDetail || 'full';
        const outputResults = resultDetail === 'compact'
          ? results.map(compactResult)
          : resultDetail === 'value'
            ? results.map(valueOnly)
            : results;

        if ((config.outputMode || 'batch') === 'split') {
          results.forEach((result, index) => {
            const output = {
              ...msg,
              topic: result.nodeId,
              payload: valueOnly(result),
            };
            if (resultDetail === 'value') delete output.opcua;
            else output.opcua = outputResults[index];
            send(output);
          });
        } else if (points.length === 1 && !looksLikePointList(msg.payload) &&
                   !Array.isArray(msg.items) && !config.pointList) {
          const result = results[0];
          msg.topic = result.nodeId;
          msg.payload = valueOnly(result);
          if (resultDetail === 'value') delete msg.opcua;
          else msg.opcua = outputResults[0];
          send(msg);
        } else {
          msg.payload = outputResults;
          msg.opcua = {
            operation: 'read',
            total: results.length,
            good: results.filter((item) => item.statusCode === 'Good').length,
            resultDetail,
          };
          if (resultDetail === 'full') {
            msg.opcua.clientDiagnostics = node.connection.getDiagnostics?.() ||
              node.connection.client.getDiagnostics();
          }
          send(msg);
        }

        node.status({ fill: failed ? 'yellow' : 'green', shape: failed ? 'ring' : 'dot',
          text: `${results.length - failed}/${results.length} read` + (failed ? ` / ${failed} failed` : '') });
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

  RED.nodes.registerType('tier0-opcua-read', OpcUaReadNode);
};
