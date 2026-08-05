'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpcUaClient, effectiveBatchSize, normalizeNotificationBatch } = require('../lib/client');
const { setAddonForTests, resetAddonForTests } = require('../lib/native');

test.afterEach(() => resetAddonForTests());

test('uses batch native services and preserves request order', async () => {
  const calls = [];
  setAddonForTests({
    connectAsync: async () => 7,
    readManyAsync: async (_client, items) => {
      calls.push(items.map((item) => item.nodeId));
      return items.map((item) => ({ nodeId: item.nodeId, value: item.nodeId, statusCode: 'Good' }));
    },
    disconnectAsync: async () => {},
  });
  const client = new OpcUaClient({ endpoint: 'opc.tcp://test:4840' });
  const points = Array.from({ length: 5 }, (_, index) => ({ nodeId: `ns=2;i=${index}` }));
  const values = await client.readMany(points, 2);
  assert.deepEqual(calls.map((batch) => batch.length), [2, 2, 1]);
  assert.deepEqual(values.map((item) => item.nodeId), points.map((item) => item.nodeId));
  await client.disconnect();
});

test('creates one subscription and adds monitored items in batches', async () => {
  let subscriptions = 0;
  const batches = [];
  setAddonForTests({
    connectAsync: async () => 9,
    createSubscriptionAsync: async () => ({ subscriptionId: ++subscriptions, statusCode: 'Good' }),
    addMonitoredItemsAsync: async (_client, _subscription, items) => {
      batches.push(items.length);
      return items.map((item, index) => ({ nodeId: item.nodeId, monitoredItemId: index + 1, statusCode: 'Good' }));
    },
    deleteSubscriptionAsync: async () => ({ statusCode: 'Good' }),
    disconnectAsync: async () => {},
  });
  const client = new OpcUaClient({ endpoint: 'opc.tcp://test:4840' });
  const subscription = await client.createSubscription({}, () => {});
  await client.addMonitoredItems(
    subscription.subscriptionId,
    Array.from({ length: 1200 }, (_, index) => ({ nodeId: `ns=2;i=${index}` })),
    {},
    500
  );
  assert.equal(subscriptions, 1);
  assert.deepEqual(batches, [500, 500, 200]);
  await client.deleteSubscription(subscription.subscriptionId);
  await client.disconnect();
});

test('normalizes native notification batches and legacy single changes', () => {
  const change = { nodeId: 'ns=2;i=1', value: 42 };
  assert.deepEqual(normalizeNotificationBatch(change), { changes: [change], diagnostics: {} });
  assert.deepEqual(normalizeNotificationBatch({ changes: [change], diagnostics: { dropped: 2 } }), {
    changes: [change],
    diagnostics: { dropped: 2 },
  });
});

test('clamps service batches to server operation limits', async () => {
  const readBatches = [];
  const writeBatches = [];
  const monitoredBatches = [];
  setAddonForTests({
    connectAsync: async () => 11,
    getClientDiagnostics: () => ({
      operationLimits: {
        maxNodesPerRead: 2,
        maxNodesPerWrite: 3,
        maxMonitoredItemsPerCall: 4,
      },
      nodeIdCache: {},
    }),
    readManyAsync: async (_client, items) => {
      readBatches.push(items.length);
      return items;
    },
    writeManyAsync: async (_client, items) => {
      writeBatches.push(items.length);
      return items;
    },
    addMonitoredItemsAsync: async (_client, _subscription, items) => {
      monitoredBatches.push(items.length);
      return items;
    },
    disconnectAsync: async () => {},
  });
  const client = new OpcUaClient({ endpoint: 'opc.tcp://test:4840' });
  const points = Array.from({ length: 9 }, (_, index) => ({
    nodeId: `ns=2;i=${index}`,
    value: index,
  }));
  await client.readMany(points, 500);
  await client.writeMany(points, 500);
  await client.addMonitoredItems(1, points, {}, 500);
  assert.deepEqual(readBatches, [2, 2, 2, 2, 1]);
  assert.deepEqual(writeBatches, [3, 3, 3]);
  assert.deepEqual(monitoredBatches, [4, 4, 1]);
  assert.equal(effectiveBatchSize(200, 0), 200);
  assert.equal(effectiveBatchSize(200, undefined), 200);
  await client.disconnect();
});

test('keeps the native handle during recoverable reconnect and resumes on activation', async () => {
  let stateCallback;
  let disconnects = 0;
  let reads = 0;
  setAddonForTests({
    connectAsync: async (_options, callback) => {
      stateCallback = callback;
      return 21;
    },
    readManyAsync: async (_client, items) => {
      reads += 1;
      return items;
    },
    getClientDiagnostics: () => ({
      connection: { state: 'connected', connected: true, sessionGeneration: 1 },
      operationLimits: {},
      nodeIdCache: {},
    }),
    disconnectAsync: async () => { disconnects += 1; },
  });
  const client = new OpcUaClient({ endpoint: 'opc.tcp://test:4840' });
  await client.connect();
  stateCallback({
    state: 'reconnecting', connected: false, recoverable: true,
    terminal: false, statusCode: 'Good', sessionGeneration: 1,
  });
  await assert.rejects(
    () => client.readMany([{ nodeId: 'ns=2;i=1' }]),
    (error) => error.code === 'OPCUA_RECONNECTING'
  );
  assert.equal(disconnects, 0);
  stateCallback({
    state: 'connected', connected: true, recoverable: true,
    terminal: false, statusCode: 'Good', sessionGeneration: 2,
  });
  await client.readMany([{ nodeId: 'ns=2;i=1' }]);
  assert.equal(reads, 1);
  assert.equal(disconnects, 0);
  await client.disconnect();
  assert.equal(disconnects, 1);
});

test('replaces a terminal native client and reconnects with bounded backoff', async () => {
  const callbacks = [];
  let connectCalls = 0;
  let disconnects = 0;
  let readHandle;
  setAddonForTests({
    connectAsync: async (_options, callback) => {
      callbacks.push(callback);
      connectCalls += 1;
      return 30 + connectCalls;
    },
    readManyAsync: async (handle, items) => {
      readHandle = handle;
      return items;
    },
    getClientDiagnostics: () => ({
      connection: { state: 'connected', connected: true, sessionGeneration: 1 },
      operationLimits: {},
      nodeIdCache: {},
    }),
    disconnectAsync: async () => { disconnects += 1; },
  });
  const client = new OpcUaClient({
    endpoint: 'opc.tcp://test:4840', reconnectInterval: 100, maxReconnectInterval: 100,
  });
  await client.connect();
  callbacks[0]({
    state: 'failed', connected: false, recoverable: false,
    terminal: true, statusCode: 'BadConnectionRejected',
  });
  const deadline = Date.now() + 1000;
  while (connectCalls < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(connectCalls, 2);
  await client.readMany([{ nodeId: 'ns=2;i=1' }]);
  assert.equal(readHandle, 32);
  assert.equal(disconnects, 1);
  const supervisor = client.getDiagnostics().connection.supervisor;
  assert.equal(supervisor.terminalReplacements, 1);
  assert.equal(supervisor.reconnectAttempts, 1);
  assert.equal(supervisor.reconnectSuccesses, 1);
  await client.disconnect();
  assert.equal(disconnects, 2);
});
