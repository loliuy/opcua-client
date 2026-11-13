'use strict';

const { createDiagnostics } = require('../lib/diagnostics');

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
        connection.markUsed?.('editor-browse');
        const items = await connection.client.browse({
          rootNodeId,
          recursive: true,
          variablesOnly: false,
          maxDepth: positiveInteger(body.maxDepth, 10, 50),
          maxNodes: positiveInteger(body.maxNodes, 10000, 100000),
          browseBatchSize: positiveInteger(body.browseBatchSize, 100, 5000),
          referencesPerNode: positiveInteger(body.referencesPerNode, 1000, 10000),
          attributeBatchSize: positiveInteger(body.attributeBatchSize, 200, 5000),
        });
        const tree = buildBrowseTree(items, rootNodeId);
        res.send({
          tree, total: items.length, rootNodeId,
          ...(items.diagnostics || {}),
        });
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
    const diagnostics = createDiagnostics(node, config, 'browse');
    const consumer = node.connection?.registerConsumer?.('browse', {
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
        consumer?.markUsed('browse');
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
            browseBatchSize: Number(config.browseBatchSize) || 100,
            referencesPerNode: Number(config.referencesPerNode) || 1000,
            attributeBatchSize: Number(config.attributeBatchSize) || 200,
          });
        const browseDiagnostics = useSelection ? null : points.diagnostics || null;

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
              ...(browseDiagnostics ? { browse: browseDiagnostics } : {}),
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
            ...(browseDiagnostics ? { browse: browseDiagnostics } : {}),
          };
          send(msg);
        }

        const partial = browseDiagnostics?.truncated || browseDiagnostics?.failures?.length;
        if (partial) diagnostics.emit('warn', 'browse_partial', 'OPC UA Browse returned partial results', {
          failed: browseDiagnostics?.failures?.length || 0, total: points.length,
          failures: browseDiagnostics?.failures || [],
        }, send);
        node.status({
          fill: partial ? 'yellow' : 'green', shape: partial ? 'ring' : 'dot',
          text: `${points.length} points` +
            (browseDiagnostics?.truncated
              ? ` / truncated: ${browseDiagnostics.truncationReason}` : ''),
        });
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

  RED.nodes.registerType('tier0-opcua-browse', OpcUaBrowseNode);
};
