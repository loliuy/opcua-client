'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const { OpcUaClient } = require('../lib/client');

const port = 4847;
const endpoint = `opc.tcp://127.0.0.1:${port}`;

async function startFixture() {
  const nativeServer = process.env.OPCUA_TEST_SERVER_BINARY;
  const child = spawn(nativeServer || 'python3', nativeServer
    ? [String(port), '20', '500', '0']
    : [path.join(__dirname, 'fixture', 'server.py'), String(port), '20', '500']);
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { errors += data; });
  const deadline = Date.now() + 15000;
  while (!output.includes('RUNNING ') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Fixture exited: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const match = output.match(/RUNNING (opc\.tcp:\/\/\S+) (ns=\S+)/);
  if (!match) {
    child.kill('SIGTERM');
    throw new Error(`Fixture did not start: ${errors}`);
  }
  return { child, nodeId: match[2] };
}

async function stopFixture(server) {
  if (!server?.child || server.child.exitCode != null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    once(server.child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  let server = await startFixture();
  let client;
  let subscriptionId;
  const states = [];
  const changes = [];
  try {
    client = new OpcUaClient({
      endpoint,
      securityMode: 'None',
      requestTimeout: 1000,
      requestedSessionTimeout: 5000,
      connectivityCheckInterval: 500,
      reconnectInterval: 200,
      maxReconnectInterval: 1000,
    });
    client.on('state', (state) => states.push(state));
    await client.connect();
    const initialGeneration = client.getState().clientGeneration || 1;

    const subscription = await client.createSubscription(
      {
        publishingInterval: 100,
        lifetimeCount: 100,
        maxKeepAliveCount: 5,
        callbackQueueSize: 1000,
      },
      (batch) => changes.push(...(batch.changes || []))
    );
    subscriptionId = subscription.subscriptionId;
    const monitored = await client.addMonitoredItems(
      subscriptionId,
      [{ nodeId: server.nodeId, samplingInterval: 100, queueSize: 10 }],
      {}
    );
    assert.equal(monitored[0].statusCode, 'Good');

    await stopFixture(server);
    await waitFor(
      () => states.find((state) => state.state === 'reconnecting'),
      10000,
      'recoverable disconnect state'
    );

    server = await startFixture();
    const recovered = await waitFor(
      () => states.find((state) => state.state === 'connected' &&
        Number(state.clientGeneration || 0) > Number(initialGeneration)),
      15000,
      'session recovery'
    );
    assert.equal(recovered.terminal, false);

    const oldValidation = await client.validateSubscription(subscriptionId);
    assert.equal(oldValidation.valid, false);
    try { await client.deleteSubscription(subscriptionId); } catch {}

    const replacement = await client.createSubscription(
      { publishingInterval: 100, callbackQueueSize: 1000 },
      (batch) => changes.push(...(batch.changes || []))
    );
    subscriptionId = replacement.subscriptionId;
    const restored = await client.addMonitoredItems(
      subscriptionId,
      [{ nodeId: server.nodeId, samplingInterval: 100, queueSize: 10 }],
      {}
    );
    assert.equal(restored[0].statusCode, 'Good');
    await client.writeMany([
      { nodeId: server.nodeId, value: 42.5, dataType: 'Double' },
    ]);
    await waitFor(
      () => changes.some((change) => change.value === 42.5),
      5000,
      'post-reconnect notification'
    );

    const diagnostics = client.getDiagnostics();
    assert(diagnostics.connection.supervisor.reconnectAttempts >= 1);
    assert(diagnostics.connection.supervisor.reconnectSuccesses >= 1);
    assert(diagnostics.connection.supervisor.terminalReplacements >= 1);
    console.log(JSON.stringify({
      reconnectIntegration: 'passed',
      states: states.map((state) => ({
        state: state.state,
        channelState: state.channelState,
        sessionState: state.sessionState,
        statusCode: state.statusCode,
        sessionGeneration: state.sessionGeneration,
      })),
      diagnostics: diagnostics.connection,
      postReconnectValue: 42.5,
    }));
  } finally {
    if (client != null) {
      if (subscriptionId != null) {
        try { await client.deleteSubscription(subscriptionId); } catch {}
      }
      try { await client.disconnect(); } catch {}
    }
    await stopFixture(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
