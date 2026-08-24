'use strict';

const { looksLikePointList, messagePoints } = require('../lib/points');

const NOTIFICATION_CONFIG_FIELDS = new Set([
  'nodeId',
  'samplingInterval',
  'queueSize',
  'discardOldest',
  'deadbandType',
  'deadbandValue',
  'enabled',
]);

const COMPACT_NOTIFICATION_FIELDS = Object.freeze([
  'nodeId',
  'value',
  'statusCode',
  'sourceTimestamp',
]);

function valueOnly(change) {
  return Object.prototype.hasOwnProperty.call(change, 'value') ? change.value : null;
}

function compactChange(change, point) {
  const output = {};
  for (const field of COMPACT_NOTIFICATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(change, field)) output[field] = change[field];
  }
  if (point.alias != null && point.alias !== '') output.alias = point.alias;
  return output;
}

function valueChange(change, point) {
  return {
    nodeId: change.nodeId,
    ...(point.alias != null && point.alias !== '' ? { alias: point.alias } : {}),
    ...(Object.prototype.hasOwnProperty.call(change, 'value') ? { value: change.value } : {}),
  };
}

function fullChange(change, point, subscriptionId) {
  change.subscriptionId = subscriptionId;
  for (const key in point) {
    if (!NOTIFICATION_CONFIG_FIELDS.has(key) && !Object.hasOwn(change, key)) {
      change[key] = point[key];
    }
  }
  return change;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function monitoringSettings(point, config) {
  return {
    samplingInterval: Number(point.samplingInterval) || Number(config.samplingInterval) || 1000,
    queueSize: positiveInteger(point.queueSize, positiveInteger(config.queueSize, 1)),
    discardOldest: point.discardOldest !== false,
    deadbandType: point.deadbandType || config.deadbandType || 'none',
    deadbandValue: Number(point.deadbandValue ?? config.deadbandValue) || 0,
  };
}

function sameMonitoringSettings(left, right, config) {
  const leftSettings = monitoringSettings(left, config);
  const rightSettings = monitoringSettings(right, config);
  return Object.keys(leftSettings).every(
    (key) => leftSettings[key] === rightSettings[key]
  );
}

function numericRange(items, field) {
  let count = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const item of items) {
    if (item[field] == null) continue;
    const value = Number(item[field]);
    if (!Number.isFinite(value)) continue;
    count += 1;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return {
    count,
    minimum: count ? minimum : null,
    maximum: count ? maximum : null,
  };
}

module.exports = function registerSubscribeNode(RED) {
  function OpcUaSubscribeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.connection = RED.nodes.getNode(config.connection);
    node.subscriptions = new Map();
    node.desired = new Map();
    node.monitored = new Map();
    node.failed = new Map();
    node.subscriptionDiagnostics = new Map();
    node.pendingChanges = [];
    node.flushTimer = null;
    node.reconnectTimer = null;
    node.reconcileChain = Promise.resolve();
    node.reconcileAttempt = 0;
    node.lastSessionGeneration = 0;
    node.closing = false;
    node.lastDropped = 0;
    node.lastStatusAt = 0;
    const consumer = node.connection?.registerConsumer?.('subscribe', {
      nodeId: config.id, name: config.name,
    });

    const batchSize = positiveInteger(config.batchSize, 500);
    const callbackBatchSize = positiveInteger(config.callbackBatchSize, 500);
    const callbackFlushIntervalMs = positiveInteger(config.callbackFlushIntervalMs, 50);
    const configuredSubscriptionCapacity = positiveInteger(config.maxItemsPerSubscription, 5000);
    // Undefined preserves the descriptor-rich output used by Flow JSON created
    // before resultDetail existed. New editor nodes explicitly save compact.
    const resultDetail = ['compact', 'value', 'full'].includes(config.resultDetail)
      ? config.resultDetail
      : 'full';

    function subscriptionIds() {
      return [...node.subscriptions.keys()];
    }

    function primarySubscriptionId() {
      return subscriptionIds()[0] ?? null;
    }

    function subscriptionCapacity() {
      const diagnostics = node.connection?.client.getDiagnostics?.() || {};
      const serverLimit = Number(
        diagnostics.operationLimits?.maxMonitoredItemsPerSubscription
      );
      return Number.isFinite(serverLimit) && serverLimit > 0
        ? Math.min(configuredSubscriptionCapacity, Math.floor(serverLimit))
        : configuredSubscriptionCapacity;
    }

    function combinedDiagnostics() {
      const output = {
        queueDepth: 0,
        queueCapacity: 0,
        maxQueueDepth: 0,
        enqueued: 0,
        delivered: 0,
        dropped: 0,
        coalesced: 0,
        batches: 0,
        maxLagMs: 0,
        subscriptionCount: node.subscriptions.size,
        mode: config.queueMode || 'all',
        overflowPolicy: config.overflowPolicy || 'drop-oldest',
      };
      for (const diagnostics of node.subscriptionDiagnostics.values()) {
        output.queueDepth += Number(diagnostics.queueDepth) || 0;
        output.queueCapacity += Number(diagnostics.queueCapacity) || 0;
        output.maxQueueDepth += Number(diagnostics.maxQueueDepth) || 0;
        output.enqueued += Number(diagnostics.enqueued) || 0;
        output.delivered += Number(diagnostics.delivered) || 0;
        output.dropped += Number(diagnostics.dropped) || 0;
        output.coalesced += Number(diagnostics.coalesced) || 0;
        output.batches += Number(diagnostics.batchSequence) || 0;
        output.maxLagMs = Math.max(output.maxLagMs, Number(diagnostics.maxLagMs) || 0);
      }
      return output;
    }

    function updateQueueWarning(diagnostics) {
      const dropped = Number(diagnostics.dropped) || 0;
      if (dropped > node.lastDropped) {
        node.warn(`OPC UA notification queue dropped ${dropped - node.lastDropped} change(s); total ${dropped}`);
      }
      node.lastDropped = dropped;
    }

    function sendBatch(changes) {
      let accepted = 0;
      for (let index = 0; index < changes.length; index += 1) {
        if (node.desired.has(changes[index].nodeId)) {
          changes[accepted] = changes[index];
          accepted += 1;
        }
      }
      changes.length = accepted;
      if (!changes.length || node.closing) return;
      const diagnostics = combinedDiagnostics();
      updateQueueWarning(diagnostics);
      const output = {
        payload: resultDetail === 'value' ? changes.map(valueOnly) : changes,
        opcua: {
          operation: 'change',
          total: changes.length,
          subscriptionCount: node.subscriptions.size,
          resultDetail,
          queue: diagnostics,
        },
      };
      if (resultDetail === 'value') {
        // Subscription batches are sparse and may repeat one NodeId. A parallel
        // identifier array preserves every change without repeating objects.
        output.opcua.identifiers = changes.map((change) => change.alias || change.nodeId);
      }
      node.send({
        ...output,
      });
    }

    function clearFlushTimer() {
      if (node.flushTimer) clearTimeout(node.flushTimer);
      node.flushTimer = null;
    }

    function scheduleFlush() {
      if (node.flushTimer || !node.pendingChanges.length || node.closing) return;
      node.flushTimer = setTimeout(() => {
        node.flushTimer = null;
        while (node.pendingChanges.length) {
          sendBatch(node.pendingChanges.splice(0, callbackBatchSize));
        }
      }, callbackFlushIntervalMs);
      node.flushTimer.unref?.();
    }

    function flushFullBatches() {
      while (node.pendingChanges.length >= callbackBatchSize) {
        sendBatch(node.pendingChanges.splice(0, callbackBatchSize));
      }
      if (!node.pendingChanges.length) clearFlushTimer();
      else scheduleFlush();
    }

    function discardPendingChanges() {
      clearFlushTimer();
      node.pendingChanges.length = 0;
    }

    function onNativeBatch(record, batch) {
      if (node.closing || !record.id || !node.subscriptions.has(record.id)) return;
      const diagnostics = batch.diagnostics || {};
      node.subscriptionDiagnostics.set(record.id, diagnostics);
      const sourceChanges = batch.changes || [];
      const changes = [];
      for (let index = 0; index < sourceChanges.length; index += 1) {
        const change = sourceChanges[index];
        const point = node.desired.get(change.nodeId);
        if (!point) continue;
        changes.push(resultDetail === 'compact'
          ? compactChange(change, point)
          : resultDetail === 'value'
            ? valueChange(change, point)
            : fullChange(change, point, record.id));
      }

      if ((config.outputMode || 'batch') === 'single') {
        const queue = combinedDiagnostics();
        updateQueueWarning(queue);
        changes.forEach((change, index) => {
          const output = {
            topic: change.nodeId,
            payload: valueOnly(change),
          };
          if (resultDetail === 'value') {
            if (index === 0) output.opcua = { operation: 'change', resultDetail, queue };
          } else output.opcua = index === 0 ? { ...change, queue } : change;
          node.send(output);
        });
      } else if (changes.length) {
        node.pendingChanges.push(...changes);
        flushFullBatches();
        scheduleFlush();
      }

      const now = Date.now();
      const queue = combinedDiagnostics();
      if (queue.dropped > 0 || now - node.lastStatusAt >= 1000) {
        node.lastStatusAt = now;
        node.status({
          fill: queue.dropped > 0 ? 'yellow' : 'green',
          shape: queue.dropped > 0 ? 'ring' : 'dot',
          text: `${node.monitored.size} monitored / ${node.subscriptions.size} sub q:${queue.queueDepth}/${queue.queueCapacity}`,
        });
      }
    }

    async function createSubscription() {
      const record = {
        id: null,
        monitored: new Map(),
        limit: subscriptionCapacity(),
        revisedPublishingInterval: null,
        revisedLifetimeCount: null,
        revisedMaxKeepAliveCount: null,
      };
      const result = await node.connection.client.createSubscription({
        publishingInterval: Number(config.publishingInterval) || 1000,
        lifetimeCount: Number(config.lifetimeCount) || 120,
        maxKeepAliveCount: Number(config.maxKeepAliveCount) || 10,
        maxNotificationsPerPublish: Number(config.maxNotificationsPerPublish) || 0,
        callbackQueueSize: positiveInteger(config.callbackQueueSize, 10000),
        callbackBatchSize,
        queueMode: config.queueMode || 'all',
        overflowPolicy: config.overflowPolicy || 'drop-oldest',
      }, (batch) => onNativeBatch(record, batch));
      record.id = result.subscriptionId;
      record.revisedPublishingInterval = result.revisedPublishingInterval ?? null;
      record.revisedLifetimeCount = result.revisedLifetimeCount ?? null;
      record.revisedMaxKeepAliveCount = result.revisedMaxKeepAliveCount ?? null;
      node.subscriptions.set(record.id, record);
      return record;
    }

    async function addMonitoredItems(record, points) {
      if (!points.length) return [];
      const results = await node.connection.client.addMonitoredItems(
        record.id,
        points,
        {
          samplingInterval: Number(config.samplingInterval) || 1000,
          queueSize: Number(config.queueSize) || 10,
          discardOldest: config.discardOldest !== false,
          deadbandType: config.deadbandType || 'none',
          deadbandValue: Number(config.deadbandValue) || 0,
          timestampMode: config.timestampMode || 'source',
        },
        batchSize
      );
      results.forEach((result) => {
        result.subscriptionId = record.id;
        if (result.statusCode !== 'Good') return;
        const monitored = {
          subscriptionId: record.id,
          monitoredItemId: result.monitoredItemId,
          clientHandle: result.clientHandle,
          revisedSamplingInterval: result.revisedSamplingInterval ?? null,
          revisedQueueSize: result.revisedQueueSize ?? null,
        };
        record.monitored.set(result.nodeId, monitored);
        node.monitored.set(result.nodeId, monitored);
      });
      return results;
    }

    function findAvailableSubscription() {
      return [...node.subscriptions.values()].find(
        (record) => record.monitored.size < record.limit
      );
    }

    async function addDesiredPoints(points) {
      const remaining = [...points];
      const failures = [];
      while (remaining.length) {
        const record = findAvailableSubscription() || await createSubscription();
        const room = Math.max(0, record.limit - record.monitored.size);
        if (!room) continue;
        const candidates = remaining.splice(0, room);
        const byNodeId = new Map(candidates.map((point) => [point.nodeId, point]));
        const results = await addMonitoredItems(record, candidates);
        const returnedNodeIds = new Set(results.map((result) => result.nodeId));
        for (const point of candidates) {
          if (!returnedNodeIds.has(point.nodeId)) {
            failures.push({ nodeId: point.nodeId, statusCode: 'BadUnexpectedError' });
          }
        }
        const capacityFailures = [];
        results.forEach((result) => {
          if (result.statusCode === 'Good') return;
          const point = byNodeId.get(result.nodeId);
          if (/TooManyMonitoredItems/i.test(result.statusCode) && point) {
            capacityFailures.push(point);
          } else failures.push(result);
        });
        if (capacityFailures.length) {
          if (record.monitored.size === 0) {
            failures.push(...capacityFailures.map((point) => ({
              nodeId: point.nodeId,
              statusCode: 'BadTooManyMonitoredItems',
            })));
          } else {
            record.limit = record.monitored.size;
            remaining.unshift(...capacityFailures);
          }
        }
      }
      return failures;
    }

    async function removeMonitoredPoints(nodeIds) {
      const grouped = new Map();
      for (const [nodeId, monitored] of node.monitored) {
        if (!nodeIds.has(nodeId)) continue;
        if (!grouped.has(monitored.subscriptionId)) grouped.set(monitored.subscriptionId, []);
        grouped.get(monitored.subscriptionId).push({ nodeId, ...monitored });
      }
      for (const [subscriptionId, removals] of grouped) {
        const record = node.subscriptions.get(subscriptionId);
        if (!record) continue;
        const results = await node.connection.client.removeMonitoredItems(
          subscriptionId,
          removals.map((item) => item.monitoredItemId),
          batchSize
        );
        results.forEach((result, index) => {
          if (result.statusCode !== 'Good') return;
          const nodeId = removals[index].nodeId;
          record.monitored.delete(nodeId);
          node.monitored.delete(nodeId);
        });
      }
    }

    async function removeUndesiredPoints() {
      const nodeIds = new Set(
        [...node.monitored.keys()].filter((nodeId) => !node.desired.has(nodeId))
      );
      await removeMonitoredPoints(nodeIds);
    }

    async function pruneEmptySubscriptions() {
      const empty = [...node.subscriptions.values()].filter(
        (record) => record.monitored.size === 0
      );
      for (const record of empty) {
        if (node.subscriptions.size <= 1 && node.desired.size > 0) break;
        node.subscriptions.delete(record.id);
        node.subscriptionDiagnostics.delete(record.id);
        await node.connection.client.deleteSubscription(record.id);
      }
    }

    async function clearSubscriptions(keepDesired = false, ignoreErrors = false) {
      if (!keepDesired) {
        node.desired.clear();
        node.failed.clear();
      }
      discardPendingChanges();
      const records = [...node.subscriptions.values()];
      node.subscriptions.clear();
      node.monitored.clear();
      node.subscriptionDiagnostics.clear();
      const results = await Promise.allSettled(
        records.map((record) => node.connection.client.deleteSubscription(record.id))
      );
      if (!ignoreErrors) {
        const rejected = results.find((result) => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      }
    }

    async function validateSubscriptions() {
      for (const record of node.subscriptions.values()) {
        const validation = await node.connection.client.validateSubscription(record.id);
        if (!validation.valid) return false;
      }
      return true;
    }

    function failurePayload() {
      const failures = [...node.failed.values()];
      return {
        failed: failures.length,
        failures: failures.slice(0, 100),
        failuresTruncated: failures.length > 100,
      };
    }

    function statusPayload(command) {
      const ids = subscriptionIds();
      const monitoredValues = [...node.monitored.values()];
      const revisedSampling = numericRange(monitoredValues, 'revisedSamplingInterval');
      const revisedQueues = numericRange(monitoredValues, 'revisedQueueSize');
      return {
        command,
        desired: node.desired.size,
        monitored: node.monitored.size,
        ...failurePayload(),
        subscriptionCount: ids.length,
        subscriptionId: ids[0] ?? null,
        subscriptionIds: ids,
        revisions: [...node.subscriptions.values()].map((record) => ({
          subscriptionId: record.id,
          publishingInterval: record.revisedPublishingInterval,
          lifetimeCount: record.revisedLifetimeCount,
          maxKeepAliveCount: record.revisedMaxKeepAliveCount,
        })),
        monitoredRevisions: {
          count: Math.max(revisedSampling.count, revisedQueues.count),
          samplingIntervalMin: revisedSampling.minimum,
          samplingIntervalMax: revisedSampling.maximum,
          queueSizeMin: revisedQueues.minimum,
          queueSizeMax: revisedQueues.maximum,
        },
        connectionGovernance: node.connection?.getConnectionGovernance?.(),
        connectionUsage: node.connection?.getConnectionUsage?.(),
      };
    }

    async function reconcileSubscriptions(reason = 'state') {
      if (node.closing) return;
      consumer?.markUsed('subscribe-reconcile');
      if (!node.desired.size) {
        if (node.subscriptions.size) await clearSubscriptions(true);
        return;
      }

      let rebuilt = false;
      if (node.subscriptions.size) {
        let valid = false;
        try { valid = await validateSubscriptions(); } catch {}
        if (!valid) {
          await clearSubscriptions(true, true);
          rebuilt = true;
        }
      }

      await removeUndesiredPoints();
      const additions = [...node.desired.values()].filter(
        (point) => !node.monitored.has(point.nodeId)
      );
      const failures = await addDesiredPoints(additions);
      for (const point of additions) node.failed.delete(point.nodeId);
      for (const failure of failures) {
        node.failed.set(failure.nodeId, {
          nodeId: failure.nodeId,
          statusCode: failure.statusCode || 'BadUnexpectedError',
        });
      }
      await pruneEmptySubscriptions();

      node.reconcileAttempt = 0;
      node.status({
        fill: failures.length ? 'yellow' : 'green',
        shape: failures.length ? 'ring' : 'dot',
        text: `${node.monitored.size} monitored / ${node.subscriptions.size} sub` +
          (failures.length ? ` / ${failures.length} failed` : ''),
      });
      if (reason !== 'command') {
        node.send({
          payload: { ...statusPayload('recover'), rebuilt, reason },
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
      return { rebuilt, failures };
    }

    async function replacePoints(points) {
      const nextDesired = new Map(points.map((point) => [point.nodeId, point]));
      const changed = new Set();
      for (const [nodeId, monitored] of node.monitored) {
        const previous = node.desired.get(nodeId);
        const next = nextDesired.get(nodeId);
        if (!next || !previous || !sameMonitoringSettings(previous, next, config)) {
          changed.add(nodeId);
        }
      }
      node.desired = nextDesired;
      for (const nodeId of [...node.failed.keys()]) {
        if (!node.desired.has(nodeId)) node.failed.delete(nodeId);
      }
      await removeMonitoredPoints(changed);
      return reconcileSubscriptions('command');
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
      node.reconnectTimer = setTimeout(async () => {
        node.reconnectTimer = null;
        try {
          await runSerialized(() => reconcileSubscriptions(reason));
        } catch (error) {
          node.warn(`OPC UA resubscribe failed: ${error.message}`);
          node.status({ fill: 'yellow', shape: 'ring', text: 'waiting to recover' });
          scheduleReconnect(reason);
        }
      }, delay);
      node.reconnectTimer.unref?.();
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
                 (!state.subscriptionId || node.subscriptions.has(state.subscriptionId))) {
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
        const dynamicNodeId = msg.nodeId || msg.topic;
        const configuredPayload = !looksLikePointList(msg.payload) && !Array.isArray(msg.items) &&
          !dynamicNodeId ? config.pointList : '';
        const staticNodeId = dynamicNodeId ? '' : config.nodeId;
        const points = command === 'clear' ? [] : messagePoints(msg, staticNodeId, {
          samplingInterval: Number(config.samplingInterval) || 1000,
          queueSize: Number(config.queueSize) || 10,
          discardOldest: config.discardOldest !== false,
        }, {
          configuredPayload,
          format: 'auto',
        });

        node.status({ fill: 'blue', shape: 'dot', text: `${command} ${points.length}` });
        await runSerialized(async () => {
          if (command === 'replace') await replacePoints(points);
          else if (command === 'add') {
            const changed = new Set();
            points.forEach((point) => {
              const previous = node.desired.get(point.nodeId);
              if (previous && !sameMonitoringSettings(previous, point, config)) {
                changed.add(point.nodeId);
              }
              node.desired.set(point.nodeId, point);
              node.failed.delete(point.nodeId);
            });
            await removeMonitoredPoints(changed);
            await reconcileSubscriptions('command');
          } else if (command === 'remove') {
            points.forEach((point) => {
              node.desired.delete(point.nodeId);
              node.failed.delete(point.nodeId);
            });
            await reconcileSubscriptions('command');
          } else if (command === 'clear') await clearSubscriptions();
          else throw new Error(`Unsupported subscription command: ${command}`);
        });

        const failed = node.failed.size;
        node.status({
          fill: failed ? 'yellow' : 'green', shape: failed ? 'ring' : 'dot',
          text: `${node.monitored.size} monitored / ${node.subscriptions.size} sub` +
            (failed ? ` / ${failed} failed` : ''),
        });
        send({
          ...msg,
          payload: statusPayload(command),
          opcua: { operation: 'subscription-status' },
        });
        done();
      } catch (error) {
        node.status({ fill: 'red', shape: 'ring', text: error.message });
        done(error);
      }
    });

    async function cleanupSubscription() {
      node.closing = true;
      if (node.reconnectTimer) clearTimeout(node.reconnectTimer);
      node.reconnectTimer = null;
      discardPendingChanges();
      node.connection?.client.off('fault', onFault);
      node.connection?.client.off('state', onState);
      node.desired.clear();
      node.failed.clear();
      consumer?.release();
      await runSerialized(() => clearSubscriptions());
    }

    const runCleanup = node.connection?.registerDependentCleanup?.(cleanupSubscription) ||
      cleanupSubscription;

    node.on('close', async (done) => {
      try {
        await runCleanup();
      } catch (error) {
        node.warn(`OPC UA subscription cleanup failed: ${error.message}`);
      }
      done();
    });

    const configuredPoints = String(config.pointList || '').trim() ||
      String(config.nodeId || '').trim();
    if (configuredPoints) {
      setImmediate(() => {
        if (node.closing) return;
        let points;
        try {
          points = messagePoints({}, config.nodeId, {
            samplingInterval: Number(config.samplingInterval) || 1000,
            queueSize: Number(config.queueSize) || 10,
            discardOldest: config.discardOldest !== false,
          }, {
            configuredPayload: config.pointList,
            format: 'auto',
          });
        } catch (error) {
          node.status({ fill: 'red', shape: 'ring', text: error.message });
          node.warn(`OPC UA saved subscription point list is invalid: ${error.message}`);
          return;
        }
        void runSerialized(() => replacePoints(points)).then(() => {
          node.send({
            payload: statusPayload('startup'),
            opcua: { operation: 'subscription-status', startup: true },
          });
        }).catch((error) => {
          node.status({ fill: 'yellow', shape: 'ring', text: 'waiting to subscribe' });
          node.warn(`OPC UA startup subscription failed: ${error.message}`);
          scheduleReconnect('startup');
        });
      });
    }
  }

  RED.nodes.registerType('tier0-opcua-subscribe', OpcUaSubscribeNode);
};
