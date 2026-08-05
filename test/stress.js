'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const { OpcUaClient } = require('../lib/client');

const pointCount = positiveInteger(process.env.OPCUA_STRESS_POINTS, 5000);
const readRounds = positiveInteger(process.env.OPCUA_STRESS_READ_ROUNDS, 5);
const writeRounds = positiveInteger(process.env.OPCUA_STRESS_WRITE_ROUNDS, 2);
const batchSize = positiveInteger(process.env.OPCUA_STRESS_BATCH_SIZE, 500);
const port = positiveInteger(process.env.OPCUA_STRESS_PORT, 4844);
const notificationTimeout = positiveInteger(process.env.OPCUA_STRESS_NOTIFY_TIMEOUT, 60000);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function elapsed(started) {
  return Math.round((performance.now() - started) * 100) / 100;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

async function startFixture() {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const match = output.match(/RUNNING (opc\.tcp:\/\/\S+) (ns=(\d+);\S+) (ns=\d+;\S+) (\d+)/);
  if (!match) throw new Error(`Fixture did not start within 120s: ${errors}`);
  return {
    child,
    endpoint: match[1],
    namespace: Number(match[3]),
    rootNodeId: match[4],
    advertisedPoints: Number(match[5]),
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function main() {
  const totalStarted = performance.now();
  const fixtureStarted = performance.now();
  const server = await startFixture();
  const fixtureMs = elapsed(fixtureStarted);
  assert.equal(server.advertisedPoints, pointCount);

  const points = Array.from({ length: pointCount }, (_, index) => ({
    nodeId: `ns=${server.namespace};s=Factory.Area${String(Math.floor(index / 500)).padStart(3, '0')}.Point${String(index).padStart(6, '0')}`,
    dataType: 'Double',
    samplingInterval: 100,
    queueSize: 2,
  }));

  const client = new OpcUaClient({ endpoint: server.endpoint, securityMode: 'None' });
  let subscriptionId;
  let peakRss = process.memoryUsage().rss;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const cpuStarted = process.cpuUsage();

  try {
    const connectStarted = performance.now();
    await client.connect();
    const connectMs = elapsed(connectStarted);

    const browseStarted = performance.now();
    const browsed = await client.browse({
      rootNodeId: server.rootNodeId,
      recursive: true,
      variablesOnly: true,
      maxDepth: 3,
      maxNodes: pointCount + Math.ceil(pointCount / 500) + 10,
      attributeBatchSize: 200,
    });
    const browseMs = elapsed(browseStarted);
    assert.equal(browsed.length, pointCount, `Browse returned ${browsed.length}/${pointCount}`);

    const readLatencies = [];
    for (let round = 0; round < readRounds; round += 1) {
      const started = performance.now();
      const values = await client.readMany(points, batchSize);
      readLatencies.push(elapsed(started));
      assert.equal(values.length, pointCount);
      assert(values.every((item) => item.statusCode === 'Good'));
    }

    let received = 0;
    const changedNodes = new Set();
    const finalChangedNodes = new Set();
    const finalValueFloor = 1000000 + (writeRounds - 1) * pointCount;
    const subscribeStarted = performance.now();
    const subscription = await client.createSubscription({
      publishingInterval: 100,
      lifetimeCount: 600,
      maxKeepAliveCount: 20,
      callbackQueueSize: Math.max(20000, pointCount * 3),
    }, (batch) => {
      for (const change of batch.changes || [batch]) {
        received += 1;
        if (change.value >= 1000000) changedNodes.add(change.nodeId);
        if (change.value >= finalValueFloor) finalChangedNodes.add(change.nodeId);
      }
    });
    subscriptionId = subscription.subscriptionId;
    const monitored = await client.addMonitoredItems(
      subscriptionId,
      points,
      { samplingInterval: 100, queueSize: 2, discardOldest: true },
      batchSize
    );
    const subscribeMs = elapsed(subscribeStarted);
    assert.equal(monitored.length, pointCount);
    assert(monitored.every((item) => item.statusCode === 'Good'));

    const writeLatencies = [];
    for (let round = 0; round < writeRounds; round += 1) {
      const writes = points.map((point, index) => ({
        nodeId: point.nodeId,
        dataType: 'Double',
        value: 1000000 + round * pointCount + index,
      }));
      const started = performance.now();
      const results = await client.writeMany(writes, batchSize);
      writeLatencies.push(elapsed(started));
      assert.equal(results.length, pointCount);
      assert(results.every((item) => item.statusCode === 'Good'));
    }

    const notificationStarted = performance.now();
    const allChanged = await waitFor(() => finalChangedNodes.size === pointCount, notificationTimeout);
    const notificationDrainMs = elapsed(notificationStarted);
    assert(allChanged, `Final values converged for ${finalChangedNodes.size}/${pointCount} points`);

    const cleanupStarted = performance.now();
    await client.removeMonitoredItems(
      subscriptionId,
      monitored.map((item) => item.monitoredItemId),
      batchSize
    );
    await client.deleteSubscription(subscriptionId);
    subscriptionId = null;
    const cleanupMs = elapsed(cleanupStarted);

    const cpu = process.cpuUsage(cpuStarted);
    const report = {
      points: pointCount,
      batchSize,
      rounds: { read: readRounds, write: writeRounds },
      durationsMs: {
        fixture: fixtureMs,
        connect: connectMs,
        browse: browseMs,
        readP50: percentile(readLatencies, 0.5),
        readP95: percentile(readLatencies, 0.95),
        writeP50: percentile(writeLatencies, 0.5),
        writeP95: percentile(writeLatencies, 0.95),
        subscribe: subscribeMs,
        notificationDrain: notificationDrainMs,
        cleanup: cleanupMs,
        total: elapsed(totalStarted),
      },
      throughputPointsPerSecond: {
        browse: Math.round(pointCount / (browseMs / 1000)),
        readP50: Math.round(pointCount / (percentile(readLatencies, 0.5) / 1000)),
        writeP50: Math.round(pointCount / (percentile(writeLatencies, 0.5) / 1000)),
        subscribe: Math.round(pointCount / (subscribeMs / 1000)),
      },
      notifications: {
        received,
        distinctChanged: changedNodes.size,
        distinctFinalChanged: finalChangedNodes.size,
      },
      clientDiagnostics: client.getDiagnostics(),
      process: {
        rssMb: mb(process.memoryUsage().rss),
        peakRssMb: mb(peakRss),
        heapUsedMb: mb(process.memoryUsage().heapUsed),
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        eventLoopDelayP95Ms: Math.round((eventLoop.percentile(95) / 1e6) * 100) / 100,
        eventLoopDelayMaxMs: Math.round((eventLoop.max / 1e6) * 100) / 100,
      },
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    eventLoop.disable();
    clearInterval(memorySampler);
    if (subscriptionId != null) {
      try { await client.deleteSubscription(subscriptionId); } catch {}
    }
    try { await client.disconnect(); } catch {}
    server.child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
