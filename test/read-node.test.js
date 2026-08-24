'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registerReadNode = require('../nodes/read');

function createHarness(config = {}) {
  const diagnostics = { commandQueue: { depth: 0 } };
  const client = {
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
  };
  const connection = { client, getDiagnostics: () => diagnostics };
  let Constructor;
  const RED = {
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.status = () => {};
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

  return { diagnostics, input, sent };
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
