'use strict';

// Run against test/fixture/polling_server.py using a freshly built addon.
const assert = require('node:assert/strict');
const { OpcUaClient } = require('../lib/client');

async function main() {
  const client = new OpcUaClient({
    endpoint: process.env.OPCUA_POLLING_ENDPOINT || 'opc.tcp://127.0.0.1:4860',
    requestTimeout: 750,
  });
  const point = (nodeId) => ({ nodeId });
  const known = point('ns=0;i=2259');
  const missing = point('ns=2;s=Missing');
  const slow = point('ns=2;s=Polling.Point0');
  async function setControl(name, value, dataType) {
    const [item] = await client.writeMany([{ nodeId: 'ns=2;s=Polling.' + name, value, dataType }]);
    assert.equal(item.statusCode, 'Good');
  }
  async function verifyTimeout(responseHeaderObserved) {
    await assert.rejects(client.readMany([known, missing, slow, slow, known], 2), (error) => {
      assert.match(error.message, /Batch read failed: BadTimeout/);
      assert.deepEqual(error.readTimeout, {
        batchReturned: 0, responseHeaderObserved, total: 5, batchNumber: 2,
        batchRequested: 2, completedReturned: 2, completedGood: 1, unattempted: 1,
      });
      console.log(JSON.stringify(error.readTimeout));
      return true;
    });
  }
  try {
    await setControl('DelayMs', 0, 'UInt32');
    const mixed = await client.readMany([known, missing]);
    assert.deepEqual(mixed.map((item) => item.statusCode), ['Good', 'BadNodeIdUnknown']);
    await setControl('FailNext', true, 'Boolean');
    await verifyTimeout(true);
    await setControl('DelayMs', 1600, 'UInt32');
    await verifyTimeout(false);
  } finally {
    // Allow the delayed fixture operation to finish before restoring its controls.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    try { await setControl('DelayMs', 0, 'UInt32'); } finally { await client.disconnect(); }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
