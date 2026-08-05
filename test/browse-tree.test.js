'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBrowseTree,
  flattenBrowseTree,
  selectedVariables,
} = require('../lib/browse-tree');

const items = [
  { nodeId: 'ns=2;s=Area1', parentNodeId: 'ns=0;i=85', displayName: 'Area 1', nodeClass: 'Object' },
  { nodeId: 'ns=2;s=Area1.Line1', parentNodeId: 'ns=2;s=Area1', displayName: 'Line 1', nodeClass: 'Object' },
  { nodeId: 'ns=2;s=Area1.Speed', parentNodeId: 'ns=2;s=Area1', displayName: 'Speed', nodeClass: 'Variable', dataType: 'Double' },
  { nodeId: 'ns=2;s=Area1.Line1.Enabled', parentNodeId: 'ns=2;s=Area1.Line1', displayName: 'Enabled', nodeClass: 'Variable', dataType: 'Boolean' },
];

test('builds a nested Browse hierarchy and preserves order', () => {
  const tree = buildBrowseTree(items, 'ns=0;i=85');
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].displayName, 'Area 1');
  assert.equal(tree.children[0].children[0].displayName, 'Line 1');
  assert.deepEqual(flattenBrowseTree(tree).map((item) => item.nodeId), [
    'ns=2;s=Area1',
    'ns=2;s=Area1.Line1',
    'ns=2;s=Area1.Line1.Enabled',
    'ns=2;s=Area1.Speed',
  ]);
});

test('outputs only unique selected variable descriptors', () => {
  const selected = selectedVariables([
    items[0], items[2], items[3], { ...items[2], displayName: 'Latest Speed' },
  ]);
  assert.deepEqual(selected.map((item) => item.nodeId), [
    'ns=2;s=Area1.Speed', 'ns=2;s=Area1.Line1.Enabled',
  ]);
  assert.equal(selected[0].displayName, 'Latest Speed');
});
