'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registerSubscribeNode = require('../nodes/subscribe');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createHarness(serverLimit = 2, configOverrides = {}) {
  const client = new EventEmitter();
  const subscriptions = new Map();
  let nextSubscriptionId = 0;
  let nextMonitoredItemId = 0;

  client.getDiagnostics = () => ({
    operationLimits: { maxMonitoredItemsPerSubscription: serverLimit },
  });
  client.createSubscription = async (options, callback) => {
    const id = ++nextSubscriptionId;
    subscriptions.set(id, {
      id,
      options,
      callback,
      nextClientHandle: 1,
      monitored: new Map(),
    });
    return { subscriptionId: id, statusCode: 'Good' };
  };
  client.addMonitoredItems = async (subscriptionId, points) => {
    const subscription = subscriptions.get(subscriptionId);
    return points.map((point) => {
      const result = {
        nodeId: point.nodeId,
        monitoredItemId: ++nextMonitoredItemId,
        clientHandle: subscription.nextClientHandle++,
        statusCode: 'Good',
      };
      subscription.monitored.set(result.monitoredItemId, point.nodeId);
      return result;
    });
  };
  client.removeMonitoredItems = async (subscriptionId, ids) => {
    const subscription = subscriptions.get(subscriptionId);
    return ids.map((id) => {
      subscription.monitored.delete(id);
      return { monitoredItemId: id, statusCode: 'Good' };
    });
  };
  client.deleteSubscription = async (subscriptionId) => {
    subscriptions.delete(subscriptionId);
    return { statusCode: 'Good' };
  };
  client.validateSubscription = async (subscriptionId) => ({
    valid: subscriptions.has(subscriptionId),
    statusCode: subscriptions.has(subscriptionId) ? 'Good' : 'BadSubscriptionIdInvalid',
  });

  let Constructor;
  const RED = {
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.off = emitter.off.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.sent = [];
        node.statuses = [];
        node.warnings = [];
        node.send = (message) => node.sent.push(message);
        node.status = (status) => node.statuses.push(status);
        node.warn = (warning) => node.warnings.push(warning);
      },
      getNode: () => ({ client }),
      registerType(name, constructor) {
        assert.equal(name, 'tier0-opcua-subscribe');
        Constructor = constructor;
      },
    },
  };
  registerSubscribeNode(RED);
  const node = new Constructor({
    connection: 'connection-1',
    publishingInterval: 100,
    samplingInterval: 100,
    batchSize: 500,
    maxItemsPerSubscription: 10,
    outputMode: 'batch',
    callbackBatchSize: 3,
    callbackFlushIntervalMs: 20,
    ...configOverrides,
  });

  async function input(message) {
    return new Promise((resolve, reject) => {
      node.emit('input', message, (output) => node.sent.push(output), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async function close() {
    await new Promise((resolve) => node.emit('close', resolve));
  }

  return { client, close, input, node, subscriptions };
}

test('shards monitored items by the server subscription limit', async () => {
  const harness = createHarness(2);
  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A' },
    { nodeId: 'ns=2;s=B' },
    { nodeId: 'ns=2;s=C' },
    { nodeId: 'ns=2;s=D' },
    { nodeId: 'ns=2;s=E' },
  ] });

  assert.equal(harness.subscriptions.size, 3);
  assert.deepEqual(
    [...harness.subscriptions.values()].map((subscription) => subscription.monitored.size),
    [2, 2, 1]
  );
  assert.equal(harness.node.monitored.size, 5);
  assert.equal(harness.node.sent.at(-1).payload.subscriptionCount, 3);
  assert.equal(harness.node.sent.at(-1).payload.failed, 0);
  assert.deepEqual(
    [...harness.subscriptions.values()].map((subscription) => [...subscription.monitored.values()]),
    [['ns=2;s=A', 'ns=2;s=B'], ['ns=2;s=C', 'ns=2;s=D'], ['ns=2;s=E']]
  );

  await harness.close();
});

test('supports cross-subscription removal and reuses available capacity', async () => {
  const harness = createHarness(2);
  await harness.input({ payload: ['ns=2;s=A', 'ns=2;s=B', 'ns=2;s=C', 'ns=2;s=D'] });
  await harness.input({ opcua: { command: 'remove' }, payload: ['ns=2;s=B', 'ns=2;s=C'] });
  assert.equal(harness.node.monitored.size, 2);

  await harness.input({ opcua: { command: 'add' }, payload: ['ns=2;s=E', 'ns=2;s=F'] });
  assert.equal(harness.subscriptions.size, 2);
  assert.equal(harness.node.monitored.size, 4);
  assert.deepEqual([...harness.node.monitored.keys()].sort(), [
    'ns=2;s=A', 'ns=2;s=D', 'ns=2;s=E', 'ns=2;s=F',
  ]);

  await harness.close();
});

test('flushes aggregated changes by count or time across subscriptions', async () => {
  const harness = createHarness(2);
  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A', alias: 'point-a' },
    'ns=2;s=B',
    'ns=2;s=C',
  ] });
  harness.node.sent.length = 0;
  const [first, second] = [...harness.subscriptions.values()];
  const changeA = { nodeId: 'ns=2;s=A', value: 1, clientHandle: 1 };
  const changeB = { nodeId: 'ns=2;s=B', value: 2, clientHandle: 2 };
  const changeC = { nodeId: 'ns=2;s=C', value: 3, clientHandle: 1 };

  first.callback({ changes: [
    changeA,
    changeB,
  ], diagnostics: { queueCapacity: 100, delivered: 2 } });
  assert.equal(harness.node.sent.length, 0);
  second.callback({ changes: [
    changeC,
  ], diagnostics: { queueCapacity: 100, delivered: 1 } });

  assert.equal(harness.node.sent.length, 1);
  assert.equal(harness.node.sent[0].payload.length, 3);
  assert.equal(harness.node.sent[0].payload[0], changeA);
  assert.equal(harness.node.sent[0].payload[1], changeB);
  assert.equal(harness.node.sent[0].payload[2], changeC);
  assert.equal(changeA.alias, 'point-a');
  assert.equal(changeA.samplingInterval, undefined);
  assert.equal(changeA.queueSize, undefined);
  assert.deepEqual(harness.node.sent[0].payload.map((change) => change.subscriptionId), [1, 1, 2]);

  first.callback({ changes: [
    { nodeId: 'ns=2;s=A', value: 4, clientHandle: 1 },
  ], diagnostics: { queueCapacity: 100, delivered: 3 } });
  assert.equal(harness.node.sent.length, 1);
  await wait(35);
  assert.equal(harness.node.sent.length, 2);
  assert.equal(harness.node.sent[1].payload.length, 1);

  await harness.close();
});

test('rebuilds all shards once when subscriptions become invalid', async () => {
  const harness = createHarness(2);
  await harness.input({ payload: ['ns=2;s=A', 'ns=2;s=B', 'ns=2;s=C'] });
  const originalIds = [...harness.subscriptions.keys()];
  for (const subscription of harness.subscriptions.values()) {
    subscription.invalid = true;
  }
  harness.client.validateSubscription = async (subscriptionId) => ({
    valid: !harness.subscriptions.get(subscriptionId)?.invalid,
    statusCode: 'BadSubscriptionIdInvalid',
  });

  harness.client.emit('state', { state: 'connected', reason: 'test-reconnect', sessionGeneration: 2 });
  await wait(30);

  assert.equal(harness.subscriptions.size, 2);
  assert.equal(harness.node.monitored.size, 3);
  assert.ok([...harness.subscriptions.keys()].every((id) => !originalIds.includes(id)));
  const recovery = harness.node.sent.find((message) => message.opcua?.operation === 'subscription-status' && message.opcua.recovered);
  assert.equal(recovery?.opcua.rebuilt, true);
  assert.equal(recovery?.opcua.dataGapPossible, true);

  await harness.close();
});

test('waits for in-flight reconciliation before cleaning up on close', async () => {
  const harness = createHarness(2);
  const createSubscription = harness.client.createSubscription;
  let releaseCreate;
  let createStarted;
  const createStartedPromise = new Promise((resolve) => {
    createStarted = resolve;
  });
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  harness.client.createSubscription = async (...args) => {
    createStarted();
    await createGate;
    return createSubscription(...args);
  };

  const input = harness.input({ payload: ['ns=2;s=A', 'ns=2;s=B'] });
  await createStartedPromise;
  const close = harness.close();
  releaseCreate();

  await Promise.all([input, close]);
  assert.equal(harness.subscriptions.size, 0);
  assert.equal(harness.node.subscriptions.size, 0);
  assert.equal(harness.node.monitored.size, 0);
  assert.equal(harness.node.desired.size, 0);
});

test('compact output omits Browse, native handle, server timestamp, and subscription metadata', async () => {
  const harness = createHarness(10, { resultDetail: 'compact' });
  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A', alias: 'point-a', browsePath: 'Area/A', accessLevel: 3 },
    { nodeId: 'ns=2;s=B', browsePath: 'Area/B', accessLevel: 3 },
    { nodeId: 'ns=2;s=C', browsePath: 'Area/C', accessLevel: 3 },
  ] });
  harness.node.sent.length = 0;
  const subscription = [...harness.subscriptions.values()][0];
  subscription.callback({ changes: [
    { nodeId: 'ns=2;s=A', value: 1, statusCode: 'Good', clientHandle: 1,
      sourceTimestamp: '2026-08-20T00:00:00.000Z', serverTimestamp: '2026-08-20T00:00:01.000Z' },
    { nodeId: 'ns=2;s=B', value: 2, statusCode: 'Good', clientHandle: 2,
      sourceTimestamp: '2026-08-20T00:00:00.000Z' },
    { nodeId: 'ns=2;s=C', value: 3, statusCode: 'Good', clientHandle: 3,
      sourceTimestamp: '2026-08-20T00:00:00.000Z' },
  ], diagnostics: { delivered: 3 } });

  assert.deepEqual(harness.node.sent[0].payload[0], {
    nodeId: 'ns=2;s=A', alias: 'point-a', value: 1, statusCode: 'Good',
    sourceTimestamp: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(harness.node.sent[0].payload[0].browsePath, undefined);
  assert.equal(harness.node.sent[0].payload[0].subscriptionId, undefined);
  assert.equal(harness.node.sent[0].opcua.resultDetail, 'compact');

  await harness.close();
});

test('value-only batch preserves repeated changes with parallel identifiers', async () => {
  const harness = createHarness(10, { resultDetail: 'value' });
  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A', alias: 'point-a' },
    { nodeId: 'ns=2;s=B' },
  ] });
  harness.node.sent.length = 0;
  const subscription = [...harness.subscriptions.values()][0];
  subscription.callback({ changes: [
    { nodeId: 'ns=2;s=A', value: 1 },
    { nodeId: 'ns=2;s=A', value: 2 },
    { nodeId: 'ns=2;s=B', value: 3 },
  ], diagnostics: { delivered: 3 } });

  assert.deepEqual(harness.node.sent[0].payload, [1, 2, 3]);
  assert.deepEqual(harness.node.sent[0].opcua.identifiers, [
    'point-a', 'point-a', 'ns=2;s=B',
  ]);
  assert.equal(harness.node.sent[0].opcua.resultDetail, 'value');

  await harness.close();
});

test('value-only single output keeps scalar value and queue summary without point metadata', async () => {
  const harness = createHarness(10, { resultDetail: 'value', outputMode: 'single' });
  await harness.input({ payload: [{ nodeId: 'ns=2;s=A', browsePath: 'Area/A' }] });
  harness.node.sent.length = 0;
  const subscription = [...harness.subscriptions.values()][0];
  subscription.callback({
    changes: [{ nodeId: 'ns=2;s=A', value: 42 }],
    diagnostics: { delivered: 1 },
  });

  assert.equal(harness.node.sent[0].topic, 'ns=2;s=A');
  assert.equal(harness.node.sent[0].payload, 42);
  assert.equal(harness.node.sent[0].opcua.operation, 'change');
  assert.equal(harness.node.sent[0].opcua.nodeId, undefined);
  assert.equal(harness.node.sent[0].opcua.queue.delivered, 1);

  await harness.close();
});
