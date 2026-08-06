'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chunks,
  coerceWriteValue,
  looksLikePointList,
  messagePoints,
  messageWritePoints,
  normalizePoints,
  parseCsv,
  parsePointPayload,
} = require('../lib/points');

test('normalizes and deduplicates point descriptors', () => {
  const result = normalizePoints([
    'ns=2;s=A',
    { nodeId: 'ns=2;s=B', alias: 'old' },
    { nodeId: 'ns=2;s=B', alias: 'new', samplingInterval: 250 },
    { nodeId: 'ns=2;s=Disabled', enabled: false },
  ]);
  assert.equal(result.points.length, 2);
  assert.equal(result.points[1].alias, 'new');
  assert.equal(result.points[1].samplingInterval, 250);
});

test('parses quoted CSV point lists', () => {
  const points = parseCsv([
    'nodeId,alias,dataType,samplingInterval',
    '"ns=2;s=Line,Temperature",temperature,Double,500',
  ].join('\n'));
  assert.deepEqual(points, [{
    nodeId: 'ns=2;s=Line,Temperature',
    alias: 'temperature',
    dataType: 'Double',
    samplingInterval: '500',
  }]);
});

test('auto-detects JSON and CSV payloads', () => {
  assert.equal(parsePointPayload('[{"nodeId":"ns=2;s=A"}]').length, 1);
  assert.equal(parsePointPayload('{"nodeId":"ns=2;s=A"}').length, 1);
  assert.equal(parsePointPayload('nodeId\nns=2;s=A').length, 1);
});

test('supports scalar and batch Node-RED messages', () => {
  assert.equal(messagePoints({ topic: 'ns=2;s=A', payload: 1 }).length, 1);
  assert.equal(messagePoints({ payload: ['ns=2;s=A', 'ns=2;s=B'] }).length, 2);
  assert.equal(messagePoints({ payload: '[{"nodeId":"ns=2;s=A"}]' }).length, 1);
  assert.equal(messagePoints({ payload: 'nodeId,alias\nns=2;s=A,a' }).length, 1);
  assert.equal(messagePoints({ payload: 1 }, '', {}, {
    configuredPayload: 'nodeId\nns=2;s=Imported',
  })[0].nodeId, 'ns=2;s=Imported');
});

test('parses and coerces JSON and CSV write imports', () => {
  const csv = messageWritePoints({
    payload: 'nodeId,value,dataType\nns=2;s=A,42.5,Double\nns=2;s=B,false,Boolean',
  });
  assert.equal(csv[0].value, 42.5);
  assert.equal(csv[1].value, false);
  const configured = messageWritePoints({ payload: Date.now() }, {
    pointList: '[{"nodeId":"ns=2;s=A","value":7,"dataType":"Int32"}]',
  });
  assert.equal(configured[0].value, 7);
  const legacyList = messageWritePoints({ payload: '12.5' }, {
    pointList: '[{"nodeId":"ns=2;s=Legacy","dataType":"Double","useInput":true}]',
  });
  assert.equal(legacyList[0].value, 12.5);
  const mappedList = messageWritePoints({
    payload: { 'ns=2;s=A': 1, speed: '2.5' },
  }, {
    pointList: JSON.stringify([
      { nodeId: 'ns=2;s=A', dataType: 'Int32', useInput: true },
      { nodeId: 'ns=2;s=B', alias: 'speed', dataType: 'Double', useInput: true },
    ]),
  });
  assert.deepEqual(mappedList.map((point) => point.value), [1, 2.5]);
  assert.equal(coerceWriteValue('1', 'Boolean'), true);
  assert.equal(looksLikePointList('hello'), false);
});

test('streams CSV writes into compact deduplicated points', () => {
  const points = messageWritePoints({
    payload: [
      'nodeId,value,dataType',
      'ns=2;s=A,1,Double',
      '# ignored comment',
      'ns=2;s=B,false,Boolean',
      'ns=2;s=A,2,Double',
    ].join('\r\n'),
  });
  assert.deepEqual(points, [
    { nodeId: 'ns=2;s=A', value: 2, dataType: 'Double' },
    { nodeId: 'ns=2;s=B', value: false, dataType: 'Boolean' },
  ]);

  const arrayInput = messageWritePoints({
    payload: [{ nodeId: 'ns=2;s=C', value: 3, dataType: 'Int32' }],
  }, { inputFormat: 'csv' });
  assert.equal(arrayInput[0].value, 3);
});

test('chunks large requests without losing order', () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
