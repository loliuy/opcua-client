'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDiagnostics } = require('../lib/diagnostics');

test('diagnostics use only port 2, redact raw errors, throttle and detach on close', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const client = new EventEmitter();
  const node = new EventEmitter();
  const sent = [];
  node.send = (msg) => sent.push(msg);
  node.connection = { client };
  node.error = () => {};
  const diagnostics = createDiagnostics(node, { id: 'read-1', connection: 'c1' }, 'read');
  const error = new Error('BadTimeout opc.tcp://user:secret@host token=secret payload=secret');
  diagnostics.failure(error);
  diagnostics.failure(error);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], null);
  assert.equal(sent[0][1].payload.statusCode, 'BadTimeout');
  assert.equal(sent[0][1].payload.level, 'error');
  assert.doesNotMatch(JSON.stringify(sent), /secret|opc.tcp/);
  t.mock.timers.tick(30000);
  diagnostics.failure(error);
  assert.equal(sent[1][1].payload.suppressed, 1);
  client.emit('state', { state: 'reconnecting' });
  client.emit('state', { state: 'connected' });
  assert.equal(sent.at(-1)[1].payload.event, 'connection_restored');
  node.emit('close');
  assert.equal(client.listenerCount('state'), 0);
  assert.equal(client.listenerCount('fault'), 0);
  diagnostics.failure(error);
  assert.equal(sent.length, 4);
});

for (const operation of ['read', 'write', 'browse', 'subscribe']) {
  test(`${operation} missing connection reaches output 2 and preserves done(error)`, async () => {
    let Constructor;
    const RED = {
      httpAdmin: { post() {} }, auth: { needsPermission: () => () => {} },
      nodes: {
        createNode(node) {
          const emitter = new EventEmitter();
          node.on = emitter.on.bind(emitter);
          node.emit = emitter.emit.bind(emitter);
          node.status = () => {};
        },
        getNode: () => null,
        registerType: (name, constructor) => { Constructor = constructor; },
      },
    };
    require(`../nodes/${operation}`)(RED);
    const node = new Constructor({ id: 'test', connection: '' });
    const sent = [];
    let caught;
    await new Promise((resolve) => node.emit('input', { payload: 'private' },
      (msg) => sent.push(msg), (error) => { caught = error; resolve(); }));
    assert(caught instanceof Error);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], null);
    assert.equal(sent[0][1].payload.event, `${operation}_failed`);
    assert.doesNotMatch(JSON.stringify(sent), /private/);
  });
}


test('point diagnostics identify failed nodes, omit values and do not suppress different batches', () => {
  const node = new EventEmitter();
  const sent = [];
  node.send = (msg) => sent.push(msg[1].payload);
  const diagnostics = createDiagnostics(node, { id: 'flow-node', connection: 'c1' }, 'read');
  const a = { nodeId: 'ns=2;s=A', alias: '温度', statusCode: 'BadNotReadable', value: 'private-value', token: 'private-token' };
  assert.equal(diagnostics.results([a, { nodeId: 'ns=2;s=OK', statusCode: 'Good' }]), 1);
  assert.deepEqual(sent[0].failures, [{ nodeId: a.nodeId, alias: a.alias, statusCode: a.statusCode, message: '访问级别不允许读取或订阅该点位' }]);
  assert.equal(sent[0].nodeId, 'flow-node');
  assert.equal(sent[0].total, 2);
  assert.equal(sent[0].failed, 1);
  assert.equal(sent[0].failuresTruncated, false);
  assert.doesNotMatch(JSON.stringify(sent), /private/);
  diagnostics.results([a]);
  assert.equal(sent.length, 1);
  diagnostics.results([{ ...a, nodeId: 'ns=2;s=B' }]);
  assert.equal(sent.length, 2);
  node.emit('close');
});

test('large failure lists are capped, counted and resolve aliases from the requested points', () => {
  const node = new EventEmitter();
  let output;
  node.send = (msg) => { output = msg[1].payload; };
  const diagnostics = createDiagnostics(node, {}, 'subscribe');
  const points = Array.from({ length: 105 }, (_, i) => ({ nodeId: 'ns=2;s=' + i, statusCode: 'BadNodeIdUnknown' }));
  diagnostics.results(points, undefined, new Map([[points[0].nodeId, { alias: '设备点位' }]]));
  assert.equal(output.failures.length, 100);
  assert.equal(output.failed, 105);
  assert.equal(output.omittedFailures, 5);
  assert.equal(output.failuresTruncated, true);
  assert.equal(output.failures[0].alias, '设备点位');
  node.emit('close');
});

test('connection Catch errors are per outage, local to the operation, redacted and stop on close', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const client = new EventEmitter();
  const node = new EventEmitter();
  node.id = 'read-1';
  node.connection = { client };
  const errors = [], sent = [];
  node.error = (error, msg) => errors.push({ error, msg });
  node.send = (msg) => sent.push(msg[1]);
  const diagnostics = createDiagnostics(node, { connection: 'shared' }, 'read');
  const fault = new Error('BadConnectionRejected opc.tcp://user:secret@host');
  client.emit('state', { state: 'failed', statusCode: 'BadConnectionRejected' });
  client.emit('fault', fault);
  diagnostics.backgroundFailure(fault, 'subscription_recovery_failed');
  t.mock.timers.tick(60000);
  client.emit('state', { state: 'backoff' });
  client.emit('state', { state: 'failed', statusCode: 'BadConnectionRejected' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, 'BadConnectionRejected');
  assert.equal(errors[0].msg.opcua.nodeId, 'read-1');
  assert.equal(errors[0].msg.opcua.connectionId, 'shared');
  assert.doesNotMatch(errors[0].error.message + JSON.stringify(errors), /secret|opc.tcp/);
  client.emit('state', { state: 'connected' });
  assert.equal(sent.at(-1).payload.event, 'connection_restored');
  client.emit('fault', fault);
  client.emit('state', { state: 'failed', statusCode: 'BadConnectionRejected' });
  assert.equal(errors.length, 2);
  node.emit('close');
  client.emit('fault', fault);
  diagnostics.backgroundFailure(fault, 'subscription_recovery_failed');
  assert.equal(errors.length, 2);
  assert.equal(client.listenerCount('state'), 0);
});

test('subscription retries stay latched through connection recovery until subscription succeeds', () => {
  const client = new EventEmitter();
  const node = new EventEmitter();
  node.connection = { client };
  const errors = [];
  node.error = (error, msg) => errors.push({ error, msg });
  node.send = () => {};
  const diagnostics = createDiagnostics(node, { id: 'sub-1' }, 'subscribe');
  diagnostics.backgroundFailure(new Error('BadTimeout'), 'subscription_startup_failed');
  diagnostics.backgroundFailure(new Error('BadTimeout'), 'subscription_recovery_failed');
  client.emit('state', { state: 'connected' });
  diagnostics.backgroundFailure(new Error('BadTimeout'), 'subscription_recovery_failed');
  assert.equal(errors.length, 1);
  diagnostics.recovered('subscription');
  diagnostics.backgroundFailure(new Error('BadTimeout'), 'subscription_recovery_failed');
  assert.equal(errors.length, 2);
  node.emit('close');
});
