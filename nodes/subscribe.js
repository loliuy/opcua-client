'use strict';

const { messagePoints } = require('../lib/points');

module.exports = function registerSubscribeNode(RED) {
  function OpcUaSubscribeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);
    node.subscriptionId = null;
    node.desired = new Map();
    node.monitored = new Map();
    node.reconnectTimer = null;
    node.reconcileChain = Promise.resolve();
    node.reconcileAttempt = 0;
    node.lastSessionGeneration = 0;
    node.lastRecoveryReason = '';
    node.closing = false;
    node.lastDiagnostics = {};
    node.lastDropped = 0;
    node.lastStatusAt = 0;

    const batchSize = Number(config.batchSize) || 500;

    function emitBatch(batch) {
      const diagnostics = batch.diagnostics || {};
      const results = batch.changes || [];
      for (const change of results) {
        const point = node.desired.get(change.nodeId);
        if (!point) continue;
        for (const key in point) {
          if (!Object.hasOwn(change, key)) change[key] = point[key];
        }
      }
      node.lastDiagnostics = diagnostics;
      const dropped = Number(diagnostics.dropped) || 0;
      if (dropped > node.lastDropped) {
        node.warn(`OPC UA notification queue dropped ${dropped - node.lastDropped} change(s); total ${dropped}`);
      }
      node.lastDropped = dropped;

      if (results.length) {
        if ((config.outputMode || 'batch') === 'batch') {
          node.send({
            payload: results,
            opcua: { operation: 'change', total: results.length, queue: diagnostics },
          });
        } else {
          results.forEach((result, index) => node.send({
            topic: result.nodeId,
            payload: result.value,
            opcua: index === 0 ? { ...result, queue: diagnostics } : result,
          }));
        }
      }

      const now = Date.now();
      if (dropped > 0 || now - node.lastStatusAt >= 1000) {
        node.lastStatusAt = now;
        node.status({
          fill: dropped > 0 ? 'yellow' : 'green',
          shape: dropped > 0 ? 'ring' : 'dot',
          text: `${node.monitored.size} monitored q:${diagnostics.queueDepth || 0}/${diagnostics.queueCapacity || 0}`,
        });
      }
    }

    async function ensureSubscription() {
      if (node.subscriptionId != null) return;
      const result = await node.connection.client.createSubscription({
        publishingInterval: Number(config.publishingInterval) || 1000,
        lifetimeCount: Number(config.lifetimeCount) || 120,
        maxKeepAliveCount: Number(config.maxKeepAliveCount) || 10,
        maxNotificationsPerPublish: Number(config.maxNotificationsPerPublish) || 0,
        callbackQueueSize: Number(config.callbackQueueSize) || 10000,
        callbackBatchSize: Number(config.callbackBatchSize) || 500,
        queueMode: config.queueMode || 'all',
        overflowPolicy: config.overflowPolicy || 'drop-oldest',
      }, emitBatch);
      node.subscriptionId = result.subscriptionId;
    }

    async function createMonitoredItems(points) {
      if (!points.length) return [];
      const results = await node.connection.client.addMonitoredItems(
        node.subscriptionId,
        points,
        {
          samplingInterval: Number(config.samplingInterval) || 1000,
          queueSize: Number(config.queueSize) || 10,
          discardOldest: config.discardOldest !== false,
          deadbandType: config.deadbandType || 'none',
          deadbandValue: Number(config.deadbandValue) || 0,
        },
        batchSize
      );
      results.forEach((result) => {
        if (result.statusCode === 'Good') node.monitored.set(result.nodeId, result.monitoredItemId);
      });
      return results;
    }

    async function reconcileSubscription(reason = 'state') {
      if (node.closing) return;
      if (!node.desired.size) {
        if (node.subscriptionId != null) await clearSubscription(true);
        return;
      }

      let rebuilt = false;
      if (node.subscriptionId != null) {
        const validation = await node.connection.client.validateSubscription(node.subscriptionId);
        if (!validation.valid) {
          try {
            await node.connection.client.deleteSubscription(node.subscriptionId);
          } catch {}
          node.subscriptionId = null;
          node.monitored.clear();
          rebuilt = true;
        }
      }

      await ensureSubscription();
      const removals = [];
      for (const [nodeId, monitoredItemId] of node.monitored) {
        if (!node.desired.has(nodeId)) removals.push({ nodeId, monitoredItemId });
      }
      if (removals.length) {
        const results = await node.connection.client.removeMonitoredItems(
          node.subscriptionId,
          removals.map((item) => item.monitoredItemId),
          batchSize
        );
        results.forEach((result, index) => {
          if (result.statusCode === 'Good') node.monitored.delete(removals[index].nodeId);
        });
      }

      const additions = [...node.desired.values()].filter(
        (point) => !node.monitored.has(point.nodeId)
      );
      const results = await createMonitoredItems(additions);
      const failed = results.filter((result) => result.statusCode !== 'Good');
      if (failed.length) throw new Error(`${failed.length} monitored item(s) failed to recover`);

      node.reconcileAttempt = 0;
      node.status({ fill: 'green', shape: 'dot', text: `${node.monitored.size} monitored` });
      if (reason !== 'command') {
        node.send({
          payload: {
            command: 'recover',
            desired: node.desired.size,
            monitored: node.monitored.size,
            subscriptionId: node.subscriptionId,
            rebuilt,
            reason,
          },
          opcua: {
            operation: 'subscription-status',
            recovered: true,
            rebuilt,
            reason,
            sessionGeneration: node.lastSessionGeneration,
            dataGapPossible: rebuilt,
          },
        });
      }
    }

    async function clearSubscription(keepDesired = false) {
      if (!keepDesired) node.desired.clear();
      if (node.subscriptionId != null) {
        await node.connection.client.deleteSubscription(node.subscriptionId);
      }
      node.subscriptionId = null;
      node.monitored.clear();
    }

    async function replacePoints(points) {
      node.desired = new Map(points.map((point) => [point.nodeId, point]));
      await clearSubscription(true);
      await reconcileSubscription('command');
    }

    function runSerialized(task) {
      const run = node.reconcileChain.catch(() => {}).then(task);
      node.reconcileChain = run;
      return run;
    }

    function scheduleReconnect(reason = 'connection-state', immediate = false) {
      if (node.closing || node.reconnectTimer) return;
      const base = Math.max(100, Number(config.reconnectInterval) || 5000);
      const delay = immediate ? 0 : Math.min(30000, base * (2 ** node.reconcileAttempt));
      node.reconcileAttempt += 1;
      node.lastRecoveryReason = reason;
      node.reconnectTimer = setTimeout(async () => {
        node.reconnectTimer = null;
        try {
          await runSerialized(() => reconcileSubscription(reason));
        } catch (error) {
          node.warn(`OPC UA resubscribe failed: ${error.message}`);
          node.status({ fill: 'yellow', shape: 'ring', text: 'waiting to recover' });
          scheduleReconnect(reason);
        }
      }, delay);
    }

    const onFault = () => scheduleReconnect('service-fault');
    const onState = (state) => {
      if (!state || node.closing) return;
      if (Number(state.sessionGeneration) > 0) {
        node.lastSessionGeneration = Number(state.sessionGeneration);
      }
      if (state.state === 'connected') {
        scheduleReconnect(state.reason || 'connected', true);
      } else if (state.state === 'subscription-inactive' &&
                 (!state.subscriptionId || state.subscriptionId === node.subscriptionId)) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'subscription inactive' });
        scheduleReconnect('subscription-inactive');
      } else if (['reconnecting', 'backoff', 'failed'].includes(state.state)) {
        node.status({ fill: 'yellow', shape: 'ring', text: state.state });
      }
    };
    node.connection?.client.on('fault', onFault);
    node.connection?.client.on('state', onState);

    node.on('input', async (msg, send, done) => {
      if (!node.connection) return done(new Error('OPC UA connection not configured'));
      try {
        const command = msg.opcua?.command || 'replace';
        const points = command === 'clear' ? [] : messagePoints(msg, config.nodeId, {
          samplingInterval: Number(config.samplingInterval) || 1000,
          queueSize: Number(config.queueSize) || 10,
          discardOldest: config.discardOldest !== false,
        });

        node.status({ fill: 'blue', shape: 'dot', text: `${command} ${points.length}` });
        await runSerialized(async () => {
          if (command === 'replace') await replacePoints(points);
          else if (command === 'add') {
            points.forEach((point) => node.desired.set(point.nodeId, point));
            await reconcileSubscription('command');
          } else if (command === 'remove') {
            points.forEach((point) => node.desired.delete(point.nodeId));
            await reconcileSubscription('command');
          } else if (command === 'clear') await clearSubscription();
          else throw new Error(`Unsupported subscription command: ${command}`);
        });

        node.status({ fill: 'green', shape: 'dot', text: `${node.monitored.size} monitored` });
        send({
          ...msg,
          payload: {
            command,
            desired: node.desired.size,
            monitored: node.monitored.size,
            subscriptionId: node.subscriptionId,
          },
          opcua: { operation: 'subscription-status' },
        });
        done();
      } catch (error) {
        node.status({ fill: 'red', shape: 'ring', text: error.message });
        done(error);
      }
    });

    node.on('close', async (done) => {
      node.closing = true;
      if (node.reconnectTimer) clearTimeout(node.reconnectTimer);
      node.connection?.client.off('fault', onFault);
      node.connection?.client.off('state', onState);
      node.desired.clear();
      try {
        await clearSubscription();
      } catch (error) {
        node.warn(`OPC UA subscription cleanup failed: ${error.message}`);
      }
      done();
    });
  }

  RED.nodes.registerType('tier0-opcua-subscribe', OpcUaSubscribeNode);
};
