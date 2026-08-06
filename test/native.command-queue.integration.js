'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const addon = require('../build/Release/opcua_open62541.node');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startFixture(port, pointCount) {
  const child = spawn('python3', [
    path.join(__dirname, 'fixture', 'server.py'),
    String(port),
    String(pointCount),
  ]);
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { errors += data; });
  const deadline = Date.now() + 120000;
  while (!output.includes('RUNNING ') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Fixture exited: ${errors}`);
    await wait(50);
  }
  const match = output.match(/RUNNING (opc\.tcp:\/\/\S+) \S+ (ns=\d+;\S+) (\d+)/);
  if (!match) throw new Error(`Fixture did not start: ${errors}`);
  return { child, endpoint: match[1], rootNodeId: match[2] };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(2);
  }
  return false;
}

function pointNodeId(index) {
  return `ns=2;s=Factory.Area${String(Math.floor(index / 500)).padStart(3, '0')}.Point${String(index).padStart(6, '0')}`;
}

async function main() {
  const pointCount = 3000;
  const server = await startFixture(4848, pointCount);
  let clientId;
  try {
    clientId = await addon.connectAsync({
      endpoint: server.endpoint,
      securityMode: 'None',
      commandQueueSize: 64,
      requestTimeout: 10000,
    });

    let eventLoopTicks = 0;
    const ticker = setInterval(() => { eventLoopTicks += 1; }, 1);
    const nodeIds = Array.from({ length: 200 }, (_, index) => ({ nodeId: pointNodeId(index) }));
    const writes = Array.from({ length: 200 }, (_, index) => ({
      nodeId: pointNodeId(index), value: 100000 + index, dataType: 'Double',
    }));
    const operations = [];
    for (let round = 0; round < 4; round += 1) {
      operations.push(addon.browseAsync(clientId, {
        rootNodeId: server.rootNodeId,
        recursive: true,
        variablesOnly: true,
        maxDepth: 4,
        maxNodes: pointCount + 10,
        attributeBatchSize: 200,
      }));
      operations.push(addon.readManyAsync(clientId, nodeIds));
      operations.push(addon.writeManyAsync(clientId, writes));
    }
    const results = await Promise.all(operations);
    clearInterval(ticker);
    assert.equal(results.length, 12);
    assert(eventLoopTicks > 10, `Node.js event loop stalled; ticks=${eventLoopTicks}`);
    const diagnostics = addon.getClientDiagnostics(clientId).commandQueue;
    assert.equal(diagnostics.depth, 0);
    assert.equal(diagnostics.active, 0);
    assert.equal(diagnostics.enqueued, 13);
    assert.equal(diagnostics.completed, diagnostics.enqueued);
    assert.equal(diagnostics.rejected, 0);
    assert(diagnostics.maxDepth >= 2);

    await addon.disconnectAsync(clientId);
    clientId = await addon.connectAsync({
      endpoint: server.endpoint,
      securityMode: 'None',
      commandQueueSize: 1,
      requestTimeout: 1000,
    });
    const blockingBrowse = addon.browseAsync(clientId, {
      rootNodeId: server.rootNodeId,
      recursive: true,
      variablesOnly: true,
      maxDepth: 4,
      maxNodes: pointCount + 10,
      attributeBatchSize: 50,
    });
    assert(await waitFor(() => addon.getClientDiagnostics(clientId).commandQueue.active === 1));
    const queuedReads = Array.from({ length: 8 }, () =>
      addon.readManyAsync(clientId, nodeIds)
    );
    const settled = await Promise.allSettled([blockingBrowse, ...queuedReads]);
    const queueFull = settled.filter((result) =>
      result.status === 'rejected' && /command queue is full/i.test(result.reason.message)
    );
    const queueTimedOut = settled.filter((result) =>
      result.status === 'rejected' && /timed out while queued/i.test(result.reason.message)
    );
    assert(queueFull.length > 0, 'Bounded command queue did not reject overload');
    assert(queueTimedOut.length > 0, 'Queued command timeout was not enforced');
    const overloadDiagnostics = addon.getClientDiagnostics(clientId).commandQueue;
    assert(overloadDiagnostics.rejected >= queueFull.length);
    assert(overloadDiagnostics.timedOut >= queueTimedOut.length);
    assert(overloadDiagnostics.maxDepth <= 1);

    console.log(JSON.stringify({
      nativeCommandQueueIntegration: 'passed',
      eventLoopTicks,
      normal: diagnostics,
      overload: overloadDiagnostics,
      overloadRejected: queueFull.length,
      overloadTimedOut: queueTimedOut.length,
    }));
  } finally {
    if (clientId != null) await addon.disconnectAsync(clientId).catch(() => {});
    server.child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
