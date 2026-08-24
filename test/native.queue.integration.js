'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const addon = require('../build/Release/opcua_open62541.node');

async function fixture(port) {
  const nativeServer = process.env.OPCUA_TEST_SERVER_BINARY;
  const child = spawn(nativeServer || 'python3', nativeServer
    ? [String(port), '20', '500', '0']
    : [path.join(__dirname, 'fixture', 'server.py'), String(port), '20']);
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { errors += data; });
  const deadline = Date.now() + 10000;
  while (!output.includes('RUNNING ') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Fixture exited: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const match = output.match(/RUNNING (opc\.tcp:\/\/\S+) \S+ ns=(\d+);\S+/);
  if (!match) {
    child.kill('SIGTERM');
    throw new Error(`Fixture did not start: ${errors}`);
  }
  return { child, endpoint: match[1], namespace: Number(match[2]) };
}

async function main() {
  const server = await fixture(4846);
  let clientId;
  let subscriptionId;
  try {
    clientId = await addon.connectAsync({ endpoint: server.endpoint, securityMode: 'None' });
    const points = Array.from({ length: 20 }, (_, index) => ({
      nodeId: `ns=${server.namespace};s=Factory.Area000.Point${String(index).padStart(6, '0')}`,
      samplingInterval: 10,
      queueSize: 2,
    }));
    const batches = [];
    const subscription = await addon.createSubscriptionAsync(clientId, {
      publishingInterval: 10,
      callbackQueueSize: 5,
      callbackBatchSize: 2,
      queueMode: 'all',
      overflowPolicy: 'drop-oldest',
    }, (batch) => batches.push(batch));
    subscriptionId = subscription.subscriptionId;
    const monitored = await addon.addMonitoredItemsAsync(clientId, subscriptionId, points, {});
    assert(monitored.every((item) => item.statusCode === 'Good'));
    const blockUntil = Date.now() + 250;
    while (Date.now() < blockUntil) {
      // Intentionally block JavaScript so the bounded native queue reaches capacity.
    }

    await addon.writeManyAsync(clientId, points.map((point, index) => ({
      nodeId: point.nodeId,
      dataType: 'Double',
      value: 2000000 + index,
    })));

    const deadline = Date.now() + 5000;
    while (!batches.some((batch) => (batch.diagnostics?.dropped || 0) > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(batches.length > 0);
    assert(batches.every((batch) => batch.changes.length <= 2));
    assert(batches.some((batch) => batch.diagnostics.queueCapacity === 5));
    assert(batches.some((batch) => batch.diagnostics.maxQueueDepth === 5));
    assert(batches.some((batch) => batch.diagnostics.dropped > 0));
    console.log(JSON.stringify({
      nativeQueueIntegration: 'passed',
      batches: batches.length,
      delivered: batches.at(-1).diagnostics.delivered,
      dropped: batches.at(-1).diagnostics.dropped,
      maxQueueDepth: batches.at(-1).diagnostics.maxQueueDepth,
    }));

    await addon.deleteSubscriptionAsync(clientId, subscriptionId);
    subscriptionId = null;

    const latestBatches = [];
    const latestSubscription = await addon.createSubscriptionAsync(clientId, {
      publishingInterval: 10,
      callbackQueueSize: 20,
      callbackBatchSize: 20,
      queueMode: 'latest',
      overflowPolicy: 'drop-oldest',
    }, (batch) => latestBatches.push(batch));
    subscriptionId = latestSubscription.subscriptionId;
    const latestMonitored = await addon.addMonitoredItemsAsync(clientId, subscriptionId, points, {});
    assert(latestMonitored.every((item) => item.statusCode === 'Good'));
    const writes = Array.from({ length: 4 }, () => addon.writeManyAsync(
      clientId,
      points.map((point, index) => ({
        nodeId: point.nodeId,
        dataType: 'Double',
        value: 3000000 + index,
      }))
    ));
    const latestBlockUntil = Date.now() + 500;
    while (Date.now() < latestBlockUntil) {
      // Allow the native IO thread to coalesce repeated values while JavaScript is busy.
    }
    await Promise.all(writes);
    const latestDeadline = Date.now() + 5000;
    while (!latestBatches.some((batch) => (batch.diagnostics?.coalesced || 0) > 0) && Date.now() < latestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const latestChanges = latestBatches.flatMap((batch) => batch.changes);
    const latestDiagnostics = latestBatches.at(-1)?.diagnostics || {};
    assert(latestDiagnostics.coalesced > 0);
    assert.equal(latestDiagnostics.dropped, 0);
    assert.equal(new Set(latestChanges.filter((change) => change.value >= 3000000).map((change) => change.nodeId)).size, 20);
    console.log(JSON.stringify({
      nativeLatestQueueIntegration: 'passed',
      batches: latestBatches.length,
      delivered: latestDiagnostics.delivered,
      coalesced: latestDiagnostics.coalesced,
      dropped: latestDiagnostics.dropped,
    }));

    await addon.deleteSubscriptionAsync(clientId, subscriptionId);
    subscriptionId = null;
  } finally {
    if (subscriptionId != null) {
      try { await addon.deleteSubscriptionAsync(clientId, subscriptionId); } catch {}
    }
    if (clientId != null) await addon.disconnectAsync(clientId);
    server.child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
