'use strict';

function cleanBrowseNode(item) {
  const node = { ...(item || {}) };
  delete node.children;
  return node;
}

function buildBrowseTree(items, rootNodeId = 'ns=0;i=85') {
  if (!Array.isArray(items)) throw new Error('Browse result must be an array');
  const root = {
    nodeId: rootNodeId,
    parentNodeId: '',
    browseName: rootNodeId,
    displayName: rootNodeId,
    browsePath: '',
    nodeClass: 'Root',
    children: [],
  };
  const byId = new Map([[rootNodeId, root]]);

  for (const item of items) {
    if (!item?.nodeId || item.nodeId === rootNodeId || byId.has(item.nodeId)) continue;
    byId.set(item.nodeId, { ...cleanBrowseNode(item), children: [] });
  }
  for (const node of byId.values()) {
    if (node === root) continue;
    const parent = byId.get(node.parentNodeId);
    (parent && parent !== node ? parent : root).children.push(node);
  }
  return root;
}

function flattenBrowseTree(root) {
  const output = [];
  const visit = (node) => {
    if (node.nodeClass !== 'Root') output.push(cleanBrowseNode(node));
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return output;
}

function selectedVariables(items) {
  if (!Array.isArray(items)) return [];
  const selected = new Map();
  for (const item of items) {
    if (item?.nodeId && item.nodeClass === 'Variable') {
      selected.set(item.nodeId, cleanBrowseNode(item));
    }
  }
  return [...selected.values()];
}

module.exports = { buildBrowseTree, cleanBrowseNode, flattenBrowseTree, selectedVariables };
