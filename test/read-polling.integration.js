'use strict';

// Run against test/fixture/polling_server.py. Requires a real platform addon.
// Example: OPCUA_POLLING_ENDPOINT=opc.tcp://127.0.0.1:4860 node test/read-polling.integration.js
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { OpcUaClient } = require('../lib/client');
const registerReadNode = require('../nodes/read');

const endpoint = process.env.OPCUA_POLLING_ENDPOINT || 'opc.tcp://127.0.0.1:4860';
const pointCount = 1000;
const points = Array.from({ length: pointCount }, (_, index) => ({ nodeId: `ns=2;s=Polling.Point${index}` }));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(client, inputPolicy) {
  let Constructor;
  const connection = { client, getDiagnostics: () => client.getDiagnostics() };
  registerReadNode({ nodes: {
    createNode(node) {
      const emitter = new EventEmitter();
      node.on = emitter.on.bind(emitter);
      node.emit = emitter.emit.bind(emitter);
      node.status = () => {};
      node.error = (error) => backgroundErrors.push(error.message);
      node.send = (msg) => output.push(msg);
    },
    getNode: () => connection,
    registerType: (_name, ctor) => { Constructor = ctor; },
  } });
  const output = [];
  const backgroundErrors = [];
  const node = new Constructor({ id: 'poll-read', connection: 'poll-connection', inputPolicy,
    pointList: JSON.stringify(points), batchSize: 100, resultDetail: 'compact', outputMode: 'batch' });
  return {
    node, output, backgroundErrors,
    input: () => new Promise((resolve) => node.emit('input', {}, (msg) => output.push(msg), (error) => resolve(error))),
    close: () => new Promise((resolve) => node.emit('close', false, resolve)),
  };
}

async function setControl(client, nodeId, value, dataType) {
  const results = await client.writeMany([{ nodeId: `ns=2;s=Polling.${nodeId}`, value, dataType }]);
  assert.equal(results[0].statusCode, 'Good');
}

async function scenario(inputPolicy, triggers, triggerIntervalMs = 100, expectOverload = true) {
  const client = new OpcUaClient({ endpoint, securityMode: 'None', securityPolicy: 'None',
    requestTimeout: 10000, commandQueueSize: 256 });
  let flow;
  try {
    await client.connect();
    await setControl(client, 'DelayMs', 50, 'UInt32');
    await setControl(client, 'FailNext', false, 'Boolean');
    flow = harness(client, inputPolicy);
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const durations = [];
    const readMany = client.readMany.bind(client);
    // Count whole read rounds, while leaving all transport and batching real.
    client.readMany = async (...args) => {
      const start = performance.now();
      started++;
      maxActive = Math.max(maxActive, ++active);
      try { return await readMany(...args); }
      finally { active--; durations.push(performance.now() - start); }
    };
    const start = performance.now();
    const pending = [];
    for (let index = 0; index < triggers; index++) {
      pending.push(flow.input());
      await wait(triggerIntervalMs);
    }
    const dispatchMs = performance.now() - start;
    const settled = await Promise.all(pending);
    const elapsedMs = performance.now() - start;
    assert.deepEqual(settled.filter(Boolean), [], 'successful server reads must not fail');
    const data = flow.output.filter((msg) => !Array.isArray(msg));
    for (const msg of data) {
      assert.equal(msg.payload.length, pointCount);
      assert.equal(msg.payload[0].value, 0);
      assert.equal(msg.payload[pointCount - 1].value, pointCount - 1);
      assert.equal(msg.opcua.good, pointCount);
    }
    assert.equal(active, 0);
    assert.equal(started, data.length);
    assert.equal(flow.backgroundErrors.length, 0);
    const sorted = durations.toSorted((a, b) => a - b);
    const summary = { inputPolicy: inputPolicy || 'all (legacy)', triggers, triggerIntervalMs,
      completed: data.length, skipped: triggers - started, maxActiveRounds: maxActive,
      dispatchMs: Math.round(dispatchMs), elapsedMs: Math.round(elapsedMs),
      readP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      nativeQueue: client.getDiagnostics().commandQueue };
    if (inputPolicy === 'skip-while-busy') {
      assert.equal(maxActive, 1);
      assert(data.length >= 5, 'slow server must continue producing complete rounds');
      if (expectOverload) {
        assert(triggers - started > triggers / 2, 'slow reads must skip excess polling triggers');
        assert(flow.output.some((msg) => Array.isArray(msg) && msg[1]?.payload.event === 'read_skipped_busy'));
      } else {
        assert.equal(data.length, triggers, 'a sufficient interval must complete every polling trigger');
        assert.equal(triggers - started, 0, 'a sufficient interval must not need to skip polls');
      }
      assert(data.every((msg) => msg.opcua.polling.durationMs >= 500));
      const reportedSkipped = data.reduce((total, msg) => total + msg.opcua.polling.skipped, 0);
      assert.equal(reportedSkipped, triggers - started, 'batch telemetry must account for every skipped trigger');
      summary.reportedSkipped = reportedSkipped;

      await setControl(client, 'FailNext', true, 'Boolean');
      const failure = await flow.input();
      assert.match(failure?.message || '', /BadTimeout/, 'real ServiceFault must still reach done(error)/Catch');
      assert(flow.output.some((msg) => Array.isArray(msg) && msg[1]?.payload.statusCode === 'BadTimeout'));
      const beforeRecovery = flow.output.filter((msg) => !Array.isArray(msg)).length;
      assert.equal(await flow.input(), undefined);
      assert.equal(flow.output.filter((msg) => !Array.isArray(msg)).length, beforeRecovery + 1);
      summary.serviceFailure = failure.message;
      summary.recoveredAfterFailure = true;
    } else {
      assert.equal(data.length, triggers, 'default must preserve all input messages');
      assert(maxActive > 1, 'baseline must reproduce overlapping read rounds');
    }
    return summary;
  } finally {
    await flow?.close();
    await client.disconnect();
  }
}

async function main() {
  const legacy = await scenario(undefined, 20);
  console.log(JSON.stringify({ phase: 'legacy', ...legacy }));
  const protectedPolling = await scenario('skip-while-busy', 600);
  assert(protectedPolling.readP95Ms < legacy.readP95Ms);
  const adjustedPolling = await scenario('skip-while-busy', 10, 1000, false);
  console.log(JSON.stringify({ readPollingIntegration: 'passed', pointCount, batchSize: 100,
    serverDelayPerBatchMs: 50, triggerIntervalMs: 100, legacy, protectedPolling, adjustedPolling }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
