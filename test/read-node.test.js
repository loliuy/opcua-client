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
