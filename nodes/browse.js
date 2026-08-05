'use strict';

const { chunks } = require('../lib/points');
const { buildBrowseTree, selectedVariables } = require('../lib/browse-tree');

const activeEditorBrowses = new Set();

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

module.exports = function registerBrowseNode(RED) {
  RED.httpAdmin.post(
    '/opcua-client/browse',
    RED.auth.needsPermission('opcua-client.browse'),
    async (req, res) => {
      const body = req.body || {};
      const connectionId = String(body.connectionId || '');
      const connection = RED.nodes.getNode(connectionId);
      if (!connection?.client) {
        res.status(404).send({ error: 'Connection is not deployed. Save and deploy it before loading the node tree.' });
        return;
      }
      if (activeEditorBrowses.has(connectionId)) {
        res.status(409).send({ error: 'A node-tree Browse is already running for this connection.' });
        return;
      }

      const rootNodeId = String(body.rootNodeId || 'ns=0;i=85').trim();
      if (!rootNodeId || rootNodeId.length > 1024) {
        res.status(400).send({ error: 'Invalid root NodeId.' });
        return;
      }

      activeEditorBrowses.add(connectionId);
      try {
        const items = await connection.client.browse({
          rootNodeId,
          recursive: true,
          variablesOnly: false,
          maxDepth: positiveInteger(body.maxDepth, 10, 50),
          maxNodes: positiveInteger(body.maxNodes, 10000, 100000),
          attributeBatchSize: positiveInteger(body.attributeBatchSize, 200, 5000),
        });
        const tree = buildBrowseTree(items, rootNodeId);
        res.send({ tree, total: items.length, rootNodeId });
      } catch (error) {
        const status = error?.code === 'OPCUA_RECONNECTING' ? 503 : 500;
        res.status(status).send({ error: error.message || String(error) });
      } finally {
        activeEditorBrowses.delete(connectionId);
      }
    }
  );

  function OpcUaBrowseNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);

    node.on('input', async (msg, send, done) => {
      if (!node.connection) return done(new Error('OPC UA connection not configured'));

      try {
        const rootNodeId = msg.nodeId || msg.topic || config.rootNodeId || 'ns=0;i=85';
        node.status({ fill: 'blue', shape: 'dot', text: 'browsing' });
        const configuredSelection = selectedVariables(config.selectedNodes);
        const useSelection = configuredSelection.length > 0 && msg.opcua?.liveBrowse !== true;
        const points = useSelection ? configuredSelection : await node.connection.client.browse({
            rootNodeId,
            recursive: config.recursive !== false,
            maxDepth: Number(config.maxDepth) || 10,
            maxNodes: Number(config.maxNodes) || 10000,
            variablesOnly: config.variablesOnly !== false,
            namespaceIndexes: msg.opcua?.namespaceIndexes || [],
            attributeBatchSize: Number(config.attributeBatchSize) || 200,
          });

        const outputMode = config.outputMode || 'all';
        if (outputMode === 'paged') {
          const pages = chunks(points, Number(config.pageSize) || 500);
          pages.forEach((page, index) => send({
            ...msg,
            payload: page,
            opcua: {
              ...(msg.opcua || {}),
              command: index === 0 ? 'replace' : 'add',
              source: useSelection ? 'browse-selection' : 'browse',
              rootNodeId,
              page: index + 1,
              pages: pages.length,
              done: index === pages.length - 1,
              total: points.length,
            },
          }));
        } else {
          msg.payload = points;
          msg.opcua = {
            ...(msg.opcua || {}),
            command: 'replace',
            source: useSelection ? 'browse-selection' : 'browse',
            rootNodeId,
            done: true,
            total: points.length,
          };
          send(msg);
        }

        node.status({ fill: 'green', shape: 'dot', text: `${points.length} points` });
        done();
      } catch (error) {
        node.status({ fill: 'red', shape: 'ring', text: error.message });
        done(error);
      }
    });
  }

  RED.nodes.registerType('tier0-opcua-browse', OpcUaBrowseNode);
};
