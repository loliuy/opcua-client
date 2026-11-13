'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registerSubscribeNode = require('../nodes/subscribe');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createHarness(serverLimit = 2, configOverrides = {}, clientOptions = {}) {
  const client = new EventEmitter();
  client.options = { ...clientOptions };
  const subscriptions = new Map();
  const dependentCleanups = new Set();
  const calls = { create: 0, add: [], remove: [], delete: [] };
  let nextSubscriptionId = 0;
  let nextMonitoredItemId = 0;

  client.getDiagnostics = () => ({
    operationLimits: { maxMonitoredItemsPerSubscription: serverLimit },
  });
  client.createSubscription = async (options, callback) => {
    calls.create += 1;
    const id = ++nextSubscriptionId;
    subscriptions.set(id, {
      id,
      options,
      callback,
      nextClientHandle: 1,
      monitored: new Map(),
    });
    return {
      subscriptionId: id,
      statusCode: 'Good',
      revisedPublishingInterval: options.publishingInterval,
      revisedLifetimeCount: options.lifetimeCount,
      revisedMaxKeepAliveCount: options.maxKeepAliveCount,
    };
  };
  client.addMonitoredItems = async (subscriptionId, points) => {
    calls.add.push({
      subscriptionId,
      nodeIds: points.map((point) => point.nodeId),
      points: points.map((point) => ({ ...point })),
    });
    const subscription = subscriptions.get(subscriptionId);
    return points.map((point) => {
      const result = {
        nodeId: point.nodeId,
        monitoredItemId: ++nextMonitoredItemId,
        clientHandle: subscription.nextClientHandle++,
        revisedSamplingInterval: point.samplingInterval,
        revisedQueueSize: point.queueSize,
        statusCode: 'Good',
      };
      subscription.monitored.set(result.monitoredItemId, point.nodeId);
      return result;
    });
  };
  client.removeMonitoredItems = async (subscriptionId, ids) => {
    calls.remove.push({ subscriptionId, ids: [...ids] });
    const subscription = subscriptions.get(subscriptionId);
    return ids.map((id) => {
      subscription.monitored.delete(id);
      return { monitoredItemId: id, statusCode: 'Good' };
    });
  };
  client.deleteSubscription = async (subscriptionId) => {
    calls.delete.push(subscriptionId);
    subscriptions.delete(subscriptionId);
    return { statusCode: 'Good' };
  };
  client.validateSubscription = async (subscriptionId) => ({
    valid: subscriptions.has(subscriptionId),
    statusCode: subscriptions.has(subscriptionId) ? 'Good' : 'BadSubscriptionIdInvalid',
  });

  let Constructor;
  const connection = {
    client,
    registerDependentCleanup(cleanup) {
      let promise = null;
      const run = () => {
        if (!promise) {
          promise = Promise.resolve().then(cleanup).finally(() => dependentCleanups.delete(run));
        }
        return promise;
      };
      dependentCleanups.add(run);
      return run;
    },
  };
  const RED = {
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.off = emitter.off.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.sent = [];
        node.diagnostics = [];
        node.statuses = [];
        node.warnings = [];
        node.errors = [];
        node.error = (error, msg) => node.errors.push({ error, msg });
        node.send = (message) => {
          if (Array.isArray(message)) {
            if (message[0]) node.sent.push(message[0]);
            if (message[1]) node.diagnostics.push(message[1]);
          } else node.sent.push(message);
        };
        node.status = (status) => node.statuses.push(status);
        node.warn = (warning) => node.warnings.push(warning);
      },
      getNode: () => connection,
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
      node.emit('input', message, (output) => node.send(output), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async function close() {
    await new Promise((resolve) => node.emit('close', resolve));
  }

  return { calls, client, close, dependentCleanups, input, node, subscriptions };
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

test('applies conservative Siemens WinCC capacity and removes unsupported Deadband filters', async () => {
  const harness = createHarness(0, {
    maxItemsPerSubscription: 5000,
    deadbandType: 'percent',
    deadbandValue: 2,
  }, { compatibilityProfile: 'siemens-wincc' });
  const points = Array.from({ length: 1001 }, (_, index) => ({
    nodeId: `ns=2;s=Point${index}`,
    deadbandType: index === 0 ? 'absolute' : undefined,
    deadbandValue: index === 0 ? 1 : undefined,
  }));

  await harness.input({ payload: points });

  assert.equal(harness.subscriptions.size, 2);
  assert.deepEqual(
    [...harness.subscriptions.values()].map((subscription) => subscription.monitored.size),
    [1000, 1]
  );
  assert.equal(harness.calls.add[0].points[0].deadbandType, 'none');
  assert.equal(harness.calls.add[0].points[0].deadbandValue, 0);
  assert.equal(harness.node.warnings.length, 1);
  assert.match(harness.node.warnings[0], /Deadband was disabled/);
  const status = harness.node.sent.at(-1).payload;
  assert.deepEqual(status.compatibility, {
    profile: 'siemens-wincc',
    deadbandSupported: false,
    monitoredItemsPerSubscription: 1000,
  });
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

test('reconciles identical replace commands without rebuilding monitored items', async () => {
  const harness = createHarness(10);
  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A', alias: 'old-a', samplingInterval: 100 },
    { nodeId: 'ns=2;s=B', samplingInterval: 100 },
  ] });
  const initial = {
    create: harness.calls.create,
    add: harness.calls.add.length,
    remove: harness.calls.remove.length,
    delete: harness.calls.delete.length,
  };

  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A', alias: 'new-a', samplingInterval: 100 },
    { nodeId: 'ns=2;s=B', samplingInterval: 100 },
  ] });

  assert.deepEqual({
    create: harness.calls.create,
    add: harness.calls.add.length,
    remove: harness.calls.remove.length,
    delete: harness.calls.delete.length,
  }, initial);
  assert.equal(harness.node.desired.get('ns=2;s=A').alias, 'new-a');

  await harness.input({ payload: [
    { nodeId: 'ns=2;s=A', alias: 'new-a', samplingInterval: 250 },
    { nodeId: 'ns=2;s=B', samplingInterval: 100 },
  ] });
  assert.equal(harness.calls.create, initial.create);
  assert.equal(harness.calls.delete.length, initial.delete);
  assert.equal(harness.calls.remove.length, initial.remove + 1);
  assert.equal(harness.calls.add.length, initial.add + 1);
  assert.deepEqual(harness.calls.add.at(-1).nodeIds, ['ns=2;s=A']);

  await harness.close();
});

test('reports individual monitored-item failures without rejecting successful points', async () => {
  const harness = createHarness(10);
  const addMonitoredItems = harness.client.addMonitoredItems;
  harness.client.addMonitoredItems = async (...args) => {
    const results = await addMonitoredItems(...args);
    const failed = results.find((result) => result.nodeId === 'ns=2;s=Bad');
    if (failed) {
      const subscription = harness.subscriptions.get(args[0]);
      subscription.monitored.delete(failed.monitoredItemId);
      failed.monitoredItemId = 0;
      failed.statusCode = 'BadNodeIdUnknown';
    }
    return results;
  };

  await harness.input({ payload: ['ns=2;s=A', 'ns=2;s=Bad', 'ns=2;s=B'] });

  const status = harness.node.sent.at(-1).payload;
  assert.equal(status.desired, 3);
  assert.equal(status.monitored, 2);
  assert.equal(status.failed, 1);
  assert.deepEqual(status.failures, [{
    nodeId: 'ns=2;s=Bad', statusCode: 'BadNodeIdUnknown',
  }]);
  assert.equal(harness.node.statuses.at(-1).fill, 'yellow');

  await harness.close();
});

test('starts a saved point list automatically after deploy', async () => {
  const harness = createHarness(10, {
    pointList: JSON.stringify([
      { nodeId: 'ns=2;s=A', samplingInterval: 100 },
      { nodeId: 'ns=2;s=B', samplingInterval: 100 },
    ]),
  });

  for (let attempt = 0; attempt < 20 && harness.node.monitored.size !== 2; attempt += 1) {
    await wait(5);
  }
  assert.equal(harness.node.monitored.size, 2);
  assert.equal(harness.calls.create, 1);
  const startup = harness.node.sent.find((message) => message.opcua?.startup === true);
  assert.equal(startup?.payload.command, 'startup');
  assert.equal(startup?.payload.failed, 0);

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

test('shares one idempotent subscription cleanup with Connection shutdown', async () => {
  const harness = createHarness(10);
  let deletes = 0;
  const deleteSubscription = harness.client.deleteSubscription;
  harness.client.deleteSubscription = async (...args) => {
    deletes += 1;
    await wait(10);
    return deleteSubscription(...args);
  };
  await harness.input({ payload: ['ns=2;s=A'] });
  assert.equal(harness.dependentCleanups.size, 1);
  const connectionCleanup = [...harness.dependentCleanups][0];

  await Promise.all([harness.close(), connectionCleanup()]);

  assert.equal(deletes, 1);
  assert.equal(harness.subscriptions.size, 0);
  assert.equal(harness.dependentCleanups.size, 0);
  assert.equal(harness.node.warnings.length, 0);
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


test('separate diagnostic port reports failure and inactivity without mixing status with data', async () => {
  const harness = createHarness(2, { statusOutput: 'separate', outputMode: 'single' });
  try {
    await harness.input({ payload: [{ nodeId: 'ns=2;s=A' }] });
    assert.equal(harness.node.sent.length, 0);
    assert.equal(harness.node.diagnostics[0].payload.event, 'subscription_updated');
    const record = [...harness.subscriptions.values()][0];
    record.callback({ changes: [{ nodeId: 'ns=2;s=A', value: 42, statusCode: 'Good' }] });
    assert.equal(harness.node.sent[0].payload, 42);
    record.callback({ changes: [{ nodeId: 'ns=2;s=A', value: null, statusCode: 'BadNoCommunication' }] });
    assert(harness.node.diagnostics.some((msg) => msg.payload.event === 'points_failed'));
    harness.client.emit('state', { state: 'subscription-inactive', subscriptionId: record.id });
    assert(harness.node.diagnostics.some((msg) => msg.payload.event === 'subscription_inactive'));
  } finally { await harness.close(); }
});

test('legacy subscription status is retained and recovery also reaches output 2', async () => {
  const harness = createHarness(2);
  try {
    await harness.input({ payload: [{ nodeId: 'ns=2;s=A' }] });
    assert.equal(harness.node.sent[0].opcua.operation, 'subscription-status');
    harness.subscriptions.clear();
    harness.client.emit('state', { state: 'connected', sessionGeneration: 2 });
    await wait(30);
    const recovered = harness.node.diagnostics.find((msg) => msg.payload.event === 'subscription_restored');
    assert.equal(recovered.payload.rebuilt, true);
    assert.equal(recovered.payload.dataGapPossible, true);
    assert(harness.node.sent.some((msg) => msg.opcua?.recovered));
  } finally { await harness.close(); }
});

test('automatic subscription failures reach Catch once and re-arm after successful reconciliation', async (t) => {
  const harness = createHarness(2, { nodeId: 'ns=2;s=A', reconnectInterval: 100 });
  t.after(() => harness.close());
  const originalCreate = harness.client.createSubscription;
  harness.client.createSubscription = async () => { throw new Error('BadTimeout secret=private'); };
  await wait(400);
  assert.equal(harness.node.errors.length, 1);
  assert.equal(harness.node.errors[0].error.code, 'BadTimeout');
  assert.doesNotMatch(harness.node.errors[0].error.message, /private/);
  assert.equal(harness.node.warnings.length, 0);
  assert(harness.node.diagnostics.some(m => m.payload.event === 'subscription_startup_failed'));
  assert(harness.node.diagnostics.some(m => m.payload.event === 'subscription_recovery_failed'));
  harness.client.createSubscription = originalCreate;
  await harness.input({ payload: [{ nodeId: 'ns=2;s=A' }] });
  assert.equal(harness.node.monitored.size, 1);
  harness.subscriptions.clear();
  harness.client.createSubscription = async () => { throw new Error('BadTimeout'); };
  harness.client.emit('state', { state: 'subscription-inactive' });
  await wait(900);
  assert.equal(harness.node.errors.length, 2);
});
