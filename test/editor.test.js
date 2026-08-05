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
