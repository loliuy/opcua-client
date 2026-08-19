'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('registers no standalone point-list node', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson['node-red'].nodes['opcua-point-list'], undefined);
  for (const name of ['connection', 'browse', 'read', 'write', 'subscribe']) {
    assert.equal(packageJson['node-red'].nodes[`tier0-opcua-${name}`], `nodes/${name}.js`);
    assert.equal(packageJson['node-red'].nodes[`opcua-${name}`], undefined);
  }
  assert.equal(fs.existsSync(path.join(root, 'nodes', 'point-list.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'nodes', 'point-list.html')), false);
});

test('Read and Write use one visible point list for manual and imported points', () => {
  for (const name of ['read', 'write']) {
    const html = read(`nodes/${name}.html`);
    assert.match(html, /id="node-input-pointFile"/);
    assert.match(html, /accept="\.json,\.csv/);
    assert.match(html, /class="red-ui-button" id="node-input-importPointList"/);
    assert.match(html, /fa fa-upload/);
    assert.match(html, /id="node-input-pointList"/);
    assert.match(html, /id="node-input-pointListItems"/);
    assert.match(html, /id="node-input-newPointNodeId"/);
    assert.match(html, /id="node-input-addPoint"/);
    assert.match(html, /Import<\/button>/);
    assert.match(html, /Clear all<\/button>/);
    assert.doesNotMatch(html, /<label[^>]*>Point file<\/label>/);
    assert.doesNotMatch(html, /<label[^>]*for="node-input-nodeId"/);
    assert.match(html, /height: 180px/);
    assert.match(html, /margin: 0 !important/);
    assert.match(html, /Advanced settings/);
    assert.match(html, /id="node-input-indexRange"/);
    assert.match(html, /indexRange: \{ value: '' \}/);
  }
});

test('Browse editor contains a tri-state selectable node tree', () => {
  const html = read('nodes/browse.html');
  assert.match(html, /id="node-input-loadTree"/);
  assert.match(html, /id="node-input-tree"/);
  assert.match(html, /prop\('indeterminate'/);
  assert.match(html, /'aria-checked', indeterminate \? 'mixed'/);
  assert.match(html, /setSubtree\(node, this\.checked\)/);
  assert.match(html, /selectedNodes: \{ value: \[\] \}/);
});

test('node editors compile and keep advanced settings collapsed by default', () => {
  for (const name of ['connection', 'browse', 'read', 'write', 'subscribe']) {
    const html = read(`nodes/${name}.html`);
    assert.match(html, new RegExp(`data-template-name="tier0-opcua-${name}"`));
    assert.match(html, new RegExp(`registerType\\('tier0-opcua-${name}'`));
    assert.match(html, /<details class="opcua-advanced">/);
    assert.doesNotMatch(html, /<details class="opcua-advanced" open>/);
    const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0][1]));
  }
});

test('Subscribe editor exposes automatic sharding and dual-threshold batching', () => {
  const html = read('nodes/subscribe.html');
  assert.match(html, /id="node-input-maxItemsPerSubscription"/);
  assert.match(html, /maxItemsPerSubscription: \{ value: 5000/);
  assert.match(html, /id="node-input-callbackFlushIntervalMs"/);
  assert.match(html, /callbackFlushIntervalMs: \{ value: 50/);
  assert.match(html, /timestampMode: \{ value: 'source'/);
  assert.match(html, /one or more OPC UA subscriptions/);
});

test('Connection editor exposes a bounded native command queue', () => {
  const html = read('nodes/connection.html');
  assert.match(html, /id="node-config-input-commandQueueSize"/);
  assert.match(html, /commandQueueSize: \{ value: 256/);
});

test('Connection editor exposes strict secure endpoint discovery and trust settings', () => {
  const html = read('nodes/connection.html');
  assert.match(html, /id="node-config-input-discoverEndpoints"/);
  assert.match(html, /id="node-config-input-testConnection"/);
  assert.match(html, /Basic256Sha256/);
  assert.match(html, /id="node-config-input-certificate"/);
  assert.match(html, /id="node-config-input-privateKey"/);
  assert.match(html, /id="node-config-input-privateKeyPassword"/);
  assert.match(html, /id="node-config-input-applicationUri"/);
  assert.match(html, /id="node-config-input-trustedCertificates"/);
  assert.match(html, /id="node-config-input-revocationList"/);
  assert.match(html, /No endpoint advertises/);
});
