'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registerReadNode = require('../nodes/read');

function createHarness(config = {}) {
  const diagnostics = { commandQueue: { depth: 0 } };
  const client = Object.assign(new EventEmitter(), {
    async readMany(points) {
      return points.map((point, index) => ({
        nodeId: point.nodeId,
        value: index + 10,
        dataType: 'Double',
        statusCode: 'Good',
        sourceTimestamp: `2026-08-20T00:00:0${index}.000Z`,
        serverTimestamp: `2026-08-20T00:00:1${index}.000Z`,
      }));
    },
    getDiagnostics: () => diagnostics,
  });
  const connection = { client, getDiagnostics: () => diagnostics };
  let Constructor;
  const RED = {
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.status = () => {};
        node.errors = [];
        node.error = (error, msg) => node.errors.push({ error, msg });
      },
      getNode: () => connection,
      registerType(name, constructor) {
        assert.equal(name, 'tier0-opcua-read');
        Constructor = constructor;
      },
    },
  };
  registerReadNode(RED);
  const node = new Constructor({
    connection: 'connection-1',
    batchSize: 500,
    outputMode: 'batch',
    ...config,
  });
  const sent = [];

  async function input(message) {
    return new Promise((resolve, reject) => {
      node.emit('input', message, (output) => sent.push(output), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return { diagnostics, input, sent, client, node };
}

const detailedPoints = [
  {
    nodeId: 'ns=2;s=A', alias: 'point-a', browseName: 'A', browsePath: 'Area/A',
    accessLevel: 3, samplingInterval: 1000, queueSize: 10, discardOldest: true,
  },
  {
    nodeId: 'ns=2;s=B', browseName: 'B', browsePath: 'Area/B',
    accessLevel: 3, samplingInterval: 1000, queueSize: 10, discardOldest: true,
  },
];

test('compact batch omits stable Browse, subscription, and diagnostic metadata', async () => {
  const harness = createHarness({
    pointList: JSON.stringify(detailedPoints),
    resultDetail: 'compact',
  });
  await harness.input({ payload: 'trigger' });

  assert.deepEqual(harness.sent[0].payload, [
    {
      nodeId: 'ns=2;s=A', alias: 'point-a', value: 10, statusCode: 'Good',
      sourceTimestamp: '2026-08-20T00:00:00.000Z',
    },
    {
      nodeId: 'ns=2;s=B', value: 11, statusCode: 'Good',
      sourceTimestamp: '2026-08-20T00:00:01.000Z',
    },
  ]);
  assert.deepEqual(harness.sent[0].opcua, {
    operation: 'read', total: 2, good: 2, resultDetail: 'compact',
  });
});

test('value-only batch preserves point-list order and sends no per-point metadata', async () => {
  const harness = createHarness({
    pointList: JSON.stringify(detailedPoints),
    resultDetail: 'value',
  });
  await harness.input({ payload: 'trigger' });

  assert.deepEqual(harness.sent[0].payload, [10, 11]);
  assert.equal(harness.sent[0].opcua.resultDetail, 'value');
  assert.equal(harness.sent[0].opcua.clientDiagnostics, undefined);
});

test('compact split keeps scalar payload and compact point identity', async () => {
  const harness = createHarness({
    pointList: JSON.stringify(detailedPoints),
    resultDetail: 'compact',
    outputMode: 'split',
  });
  await harness.input({ payload: 'trigger' });

  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[0].topic, 'ns=2;s=A');
  assert.equal(harness.sent[0].payload, 10);
  assert.equal(harness.sent[0].opcua.alias, 'point-a');
  assert.equal(harness.sent[0].opcua.browsePath, undefined);
});

test('value-only single output contains only scalar payload and topic identity', async () => {
  const harness = createHarness({ nodeId: 'ns=2;s=A', resultDetail: 'value' });
  await harness.input({ payload: 'trigger', opcua: { stale: true } });

  assert.equal(harness.sent[0].topic, 'ns=2;s=A');
  assert.equal(harness.sent[0].payload, 10);
  assert.equal(harness.sent[0].opcua, undefined);
});

test('legacy nodes without resultDetail preserve full metadata and diagnostics', async () => {
  const harness = createHarness({ pointList: JSON.stringify(detailedPoints) });
  await harness.input({ payload: 'trigger' });

  assert.equal(harness.sent[0].payload[0].browsePath, 'Area/A');
  assert.equal(harness.sent[0].payload[0].samplingInterval, 1000);
  assert.equal(harness.sent[0].payload[0].serverTimestamp, '2026-08-20T00:00:10.000Z');
  assert.equal(harness.sent[0].opcua.resultDetail, 'full');
  assert.equal(harness.sent[0].opcua.clientDiagnostics, harness.diagnostics);
});


test('value-only reads still identify inaccessible points on port 2 and show partial failure', async () => {
  const harness = createHarness({ resultDetail: 'value', pointList: JSON.stringify(detailedPoints) });
  harness.client.readMany = async () => [
    { nodeId: detailedPoints[0].nodeId, value: null, statusCode: 'BadNotReadable' },
    { nodeId: detailedPoints[1].nodeId, value: 42, statusCode: 'Good' },
  ];
  let status;
  harness.node.status = (value) => { status = value; };
  await harness.input({ payload: 'trigger' });
  const diagnostic = harness.sent.find(Array.isArray)[1].payload;
  assert.equal(diagnostic.failures[0].nodeId, detailedPoints[0].nodeId);
  assert.equal(diagnostic.failures[0].alias, 'point-a');
  assert.equal(diagnostic.failures[0].statusCode, 'BadNotReadable');
  assert.equal(status.fill, 'yellow');
  assert.match(status.text, /1\/2 read.*1 failed/);
  assert.deepEqual(harness.sent.find((msg) => !Array.isArray(msg)).payload, [null, 42]);
});

test('a failed input owns its Catch error even when the connection also emits a fault', async () => {
  const harness = createHarness({ nodeId: 'ns=2;s=A' });
  const fault = new Error('BadConnectionRejected');
  harness.client.readMany = async () => {
    harness.client.emit('state', { state: 'failed', statusCode: 'BadConnectionRejected' });
    harness.client.emit('fault', fault);
    throw fault;
  };
  await assert.rejects(harness.input({ payload: 'trigger' }), fault);
  assert.equal(harness.node.errors.length, 0, 'done(error) reports the input failure');
  harness.client.emit('fault', fault);
  assert.equal(harness.node.errors.length, 0, 'retry stays in the reported outage');
  await assert.rejects(harness.input({ payload: 'next trigger' }), fault);
  harness.client.emit('state', { state: 'connected' });
  harness.client.emit('fault', fault);
  assert.equal(harness.node.errors.length, 1, 'a new background outage reaches Catch');
  harness.node.emit('close');
});

test('a successful input does not swallow a concurrent background connection failure', async () => {
  const harness = createHarness({ nodeId: 'ns=2;s=A' });
  const readMany = harness.client.readMany;
  harness.client.readMany = async (points) => {
    harness.client.emit('fault', new Error('BadConnectionRejected'));
    return readMany(points);
  };
  await harness.input({ payload: 'trigger' });
  assert.equal(harness.node.errors.length, 1);
  assert.equal(harness.node.errors[0].error.code, 'BadConnectionRejected');
  harness.node.emit('close');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('fixed polling drops a burst while busy and reads fresh data on the next tick', async () => {
  const harness = createHarness({ inputPolicy: 'skip-while-busy', pointList: JSON.stringify(detailedPoints) });
  let status;
  harness.node.status = (value) => { status = value; };
  const readMany = harness.client.readMany;
  let gate = deferred();
  let calls = 0;
  harness.client.readMany = async (points) => {
    calls++;
    await gate.promise;
    return readMany(points);
  };
  const first = harness.input({ sequence: 1 });
  await Promise.all(Array.from({ length: 10000 }, (_, index) => harness.input({ sequence: index + 2 })));
  assert.equal(calls, 1, 'no redundant reads reach the client');
  assert.equal(harness.sent.filter((msg) => !Array.isArray(msg)).length, 0);
  const warnings = harness.sent.filter(Array.isArray).map((msg) => msg[1].payload);
  assert.equal(warnings.length, 1, 'busy warnings are throttled, not one per tick');
  assert.equal(warnings[0].event, 'read_skipped_busy');
  assert.equal(warnings[0].skipped, 1);
  assert.equal(harness.node.errors.length, 0, 'skips are not Catch errors');
  gate.resolve();
  await first;
  const output = harness.sent.find((msg) => !Array.isArray(msg));
  assert.equal(output.sequence, 1);
  assert.equal(output.opcua.polling.skipped, 10000);
  assert(output.opcua.polling.durationMs >= 0);
  assert.equal(status.fill, 'yellow');
  assert.match(status.text, /10000 skipped/);
  await new Promise(setImmediate);
  assert.equal(calls, 1, 'there is no catch-up read');
  gate = deferred();
  const next = harness.input({ sequence: 10002 });
  assert.equal(calls, 2);
  gate.resolve();
  await next;
  const outputs = harness.sent.filter((msg) => !Array.isArray(msg));
  assert.equal(outputs[1].sequence, 10002);
  assert.equal(outputs[1].opcua.polling.skipped, 0);
  assert.equal(status.fill, 'green');
});

test('default and explicit all policies preserve every dynamic read input', async () => {
  for (const inputPolicy of [undefined, 'all']) {
    const harness = createHarness({ inputPolicy });
    const readMany = harness.client.readMany;
    const gate = deferred();
    const received = [];
    harness.client.readMany = async (points) => {
      received.push(points[0].nodeId);
      await gate.promise;
      return readMany(points);
    };
    const messages = Array.from({ length: 25 }, (_, index) => ({ nodeId: `ns=2;s=P${index}` }));
    const pending = messages.map((msg) => harness.input(msg));
    assert.deepEqual(received, messages.map((msg) => msg.nodeId));
    gate.resolve();
    await Promise.all(pending);
    assert.equal(harness.sent.length, 25);
    assert(harness.sent.every((msg) => !Array.isArray(msg) && !msg.opcua.polling));
  }
});

test('polling guard releases after timeout and preserves the real Catch error', async () => {
  const harness = createHarness({ inputPolicy: 'skip-while-busy', nodeId: 'ns=2;s=A' });
  const readMany = harness.client.readMany;
  const gate = deferred();
  harness.client.readMany = () => gate.promise;
  const error = new Error('Batch read failed: BadTimeout');
  const failed = assert.rejects(harness.input({}), error);
  await harness.input({});
  gate.reject(error);
  await failed;
  assert(harness.sent.some((msg) => Array.isArray(msg) &&
    msg[1].payload.event === 'read_failed' && msg[1].payload.statusCode === 'BadTimeout'));
  harness.client.readMany = readMany;
  await harness.input({});
  assert.equal(harness.sent.filter((msg) => !Array.isArray(msg)).length, 1);
});

test('polling guard releases before done can trigger the next read', async () => {
  const harness = createHarness({ inputPolicy: 'skip-while-busy', nodeId: 'ns=2;s=A' });
  let next;
  await new Promise((resolve, reject) => {
    harness.node.emit('input', {}, (msg) => harness.sent.push(msg), (error) => {
      if (error) return reject(error);
      next = harness.input({});
      resolve();
    });
  });
  await next;
  assert.equal(harness.sent.filter((msg) => !Array.isArray(msg)).length, 2);
});

test('closing a busy Read node prevents late data/errors and completes pending inputs once', async () => {
  for (const fails of [false, true]) {
    const harness = createHarness({ inputPolicy: 'skip-while-busy', nodeId: 'ns=2;s=A' });
    const gate = deferred();
    harness.client.readMany = () => gate.promise;
    let completed = 0;
    const pending = new Promise((resolve) => {
      harness.node.emit('input', {}, (msg) => harness.sent.push(msg), (error) => {
        assert.equal(error, undefined);
        completed++;
        resolve();
      });
    });
    harness.node.emit('close');
    if (fails) gate.reject(new Error('BadTimeout'));
    else gate.resolve([{ nodeId: 'ns=2;s=A', value: 42, statusCode: 'Good' }]);
    await pending;
    await harness.input({});
    assert.equal(completed, 1);
    assert.deepEqual(harness.sent, []);
    assert.deepEqual(harness.node.errors, []);
  }
});
