'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const addon = require('../build/Release/opcua_open62541.node');

async function fixture(port) {
  const process = spawn('python3', [
    path.join(__dirname, 'fixture', 'server.py'), String(port), '20', '500', '7',
  ]);
  let output = '';
  let errors = '';
  process.stdout.on('data', (data) => { output += data; });
  process.stderr.on('data', (data) => { errors += data; });
  const deadline = Date.now() + 10000;
  while (!output.includes('RUNNING ') && Date.now() < deadline) {
    if (process.exitCode != null) throw new Error(`Fixture exited: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const match = output.match(/RUNNING (opc\.tcp:\/\/\S+) (ns=\S+)/);
  if (!match) throw new Error(`Fixture did not start: ${errors}`);
  return { process, endpoint: match[1], nodeId: match[2] };
}

async function main() {
  const server = await fixture(4843);
  let clientId;
  try {
    clientId = await addon.connectAsync({
      endpoint: server.endpoint, securityMode: 'None', nodeIdCacheSize: 32,
    });
    const browsed = await addon.browseAsync(clientId, {
      rootNodeId: 'ns=0;i=85', recursive: true, variablesOnly: true, maxDepth: 4, maxNodes: 100,
    });
    assert(browsed.some((item) => item.nodeId === server.nodeId));

    const read = await addon.readManyAsync(clientId, [{ nodeId: server.nodeId }]);
    assert.equal(read[0].statusCode, 'Good');
    assert.equal(read[0].value, 0);
    await addon.readManyAsync(clientId, [{ nodeId: server.nodeId }]);

    const changes = [];
    const notificationBatches = [];
    const subscription = await addon.createSubscriptionAsync(
      clientId,
      { publishingInterval: 100, callbackQueueSize: 1000 },
      (batch) => {
        notificationBatches.push(batch);
        changes.push(...(batch.changes || [batch]));
      }
    );
    const monitored = await addon.addMonitoredItemsAsync(
      clientId,
      subscription.subscriptionId,
      [{ nodeId: server.nodeId, samplingInterval: 100, queueSize: 10 }],
      {}
    );
    assert.equal(monitored[0].statusCode, 'Good');
    const validation = await addon.validateSubscriptionAsync(
      clientId, subscription.subscriptionId
    );
    assert.equal(validation.valid, true);

    const write = await addon.writeManyAsync(clientId, [
      { nodeId: server.nodeId, value: 42.5, dataType: 'Double' },
    ]);
    assert.equal(write[0].statusCode, 'Good');
    const deadline = Date.now() + 3000;
    while (!changes.some((change) => change.value === 42.5) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(changes.some((change) => change.value === 42.5));
    assert(notificationBatches.some((batch) => Array.isArray(batch.changes)));
    assert(notificationBatches.every((batch) => (batch.diagnostics?.dropped || 0) === 0));

    await addon.removeMonitoredItemsAsync(
      clientId,
      subscription.subscriptionId,
      [monitored[0].monitoredItemId]
    );
    await addon.deleteSubscriptionAsync(clientId, subscription.subscriptionId);
    const diagnostics = addon.getClientDiagnostics(clientId);
    assert.deepEqual(diagnostics.operationLimits, {
      maxNodesPerRead: 7,
      maxNodesPerWrite: 7,
      maxNodesPerBrowse: 7,
      maxMonitoredItemsPerCall: 7,
    });
    assert(diagnostics.nodeIdCache.size > 0);
    assert.equal(diagnostics.nodeIdCache.size, 32);
    assert.equal(diagnostics.nodeIdCache.capacity, 32);
    assert(diagnostics.nodeIdCache.hits > 0);
    assert(diagnostics.nodeIdCache.misses > 0);
    assert(diagnostics.nodeIdCache.evictions > 0);
    console.log(`native integration passed: browsed=${browsed.length}, changes=${changes.length}, cache=${JSON.stringify(diagnostics.nodeIdCache)}, limits=${JSON.stringify(diagnostics.operationLimits)}`);
  } finally {
    if (clientId != null) await addon.disconnectAsync(clientId);
    server.process.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
