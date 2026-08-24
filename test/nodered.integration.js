'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { OpcUaClient } = require('../lib/client');

const adminUrl = process.env.NODE_RED_ADMIN_URL || 'http://127.0.0.1:1880';
const pointCount = positiveInteger(process.env.OPCUA_NODERED_POINTS, 5000);
const browseNodeLimit = pointCount + Math.ceil(pointCount / 500) + 100;
const readRounds = positiveInteger(process.env.OPCUA_NODERED_READ_ROUNDS, 3);
const writeRounds = positiveInteger(process.env.OPCUA_NODERED_WRITE_ROUNDS, 5);
const batchSize = positiveInteger(process.env.OPCUA_NODERED_BATCH_SIZE, 500);
const maxItemsPerSubscription = positiveInteger(
  process.env.OPCUA_NODERED_MAX_ITEMS_PER_SUBSCRIPTION,
  5000
);
const nodeIdCacheSize = positiveInteger(
  process.env.OPCUA_NODERED_NODEID_CACHE_SIZE,
  100000
);
const port = positiveInteger(process.env.OPCUA_NODERED_SERVER_PORT, 4845);
const timeoutMs = positiveInteger(process.env.OPCUA_NODERED_TIMEOUT, 180000);
const holdMs = Number(process.env.OPCUA_NODERED_HOLD_MS) || 0;
const reconnectTest = process.env.OPCUA_NODERED_RECONNECT === '1';
const externalWriteTest = process.env.OPCUA_NODERED_EXTERNAL_WRITE === '1';
const editorBrowseTest = process.env.OPCUA_NODERED_EDITOR_BROWSE !== '0';
const routeRoot = `/_codex_opcua_bench_${Date.now().toString(36)}`;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function id() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

function ms(started) {
  return Math.round((performance.now() - started) * 100) / 100;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function request(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${text}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function jsonRequest(url, method, body) {
  return request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startFixture() {
  const nativeServer = process.env.OPCUA_TEST_SERVER_BINARY;
  const child = spawn(nativeServer || 'python3', nativeServer
    ? [String(port), String(pointCount), '500', '0']
    : [path.join(__dirname, 'fixture', 'server.py'), String(port), String(pointCount)]);
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { errors += data; });
  const deadline = Date.now() + 120000;
  while (!output.includes('RUNNING ') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Fixture exited: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const match = output.match(/RUNNING (opc\.tcp:\/\/\S+) \S+ (ns=(\d+);\S+) (\d+)/);
  if (!match) throw new Error(`Fixture did not start: ${errors}`);
  return { child, endpoint: match[1], rootNodeId: match[2], namespace: Number(match[3]) };
}

async function stopFixture(server) {
  if (!server?.child || server.child.exitCode != null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

function findNodeRedPid() {
  const ownPid = process.pid;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === ownPid) continue;
    try {
      const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (/node-red|red\.js/.test(command) && !/nodered\.integration/.test(command)) return Number(entry);
    } catch {}
  }
  return null;
}

function processSample(pid) {
  if (!pid) return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssKb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(/\s+/);
    return { rssMb: Math.round((rssKb / 1024) * 100) / 100, ticks: Number(stat[13]) + Number(stat[14]) };
  } catch {
    return null;
  }
}

function createFlow(endpoint, namespace, rootNodeId) {
  const tabId = id();
  const connectionId = id();
  const responseId = id();
  const subscribeId = id();
  const subscribeResultId = id();
  const nodes = [];
  const selectedBrowsePoints = Array.from({ length: Math.min(3, pointCount) }, (_, index) => ({
    nodeId: `ns=${namespace};s=Factory.Area${String(Math.floor(index / 500)).padStart(3, '0')}.Point${String(index).padStart(6, '0')}`,
    parentNodeId: '',
    browseName: `Point${String(index).padStart(6, '0')}`,
    displayName: `Point${String(index).padStart(6, '0')}`,
    browsePath: `Selected/Point${String(index).padStart(6, '0')}`,
    nodeClass: 'Variable',
    dataType: 'Double',
  }));

  const addHttp = (suffix, method, y) => {
    const nodeId = id();
    nodes.push({ id: nodeId, type: 'http in', z: tabId, name: suffix, url: `${routeRoot}/${suffix}`, method, upload: false, swaggerDoc: '', x: 120, y, wires: [[]] });
    return nodeId;
  };
  const addFunction = (name, func, y) => {
    const nodeId = id();
    nodes.push({ id: nodeId, type: 'function', z: tabId, name, func, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 340, y, wires: [[]] });
    return nodeId;
  };
  const wire = (from, to) => {
    const node = nodes.find((item) => item.id === from);
    node.wires[0].push(to);
  };

  nodes.push({ id: responseId, type: 'http response', z: tabId, name: 'benchmark response', statusCode: '', headers: {}, x: 1100, y: 260, wires: [] });

  const pointSource = `
const input = msg.payload || {};
const count = Math.min(Number(input.count) || ${pointCount}, ${pointCount});
msg._benchStart = Date.now();
msg._benchCount = count;
msg.payload = Array.from({length: count}, (_, index) => ({
  nodeId: 'ns=${namespace};s=Factory.Area' + String(Math.floor(index / 500)).padStart(3, '0') + '.Point' + String(index).padStart(6, '0'),
  dataType: 'Double', samplingInterval: 100, queueSize: 2
}));
return msg;`;

  const browseHttp = addHttp('browse', 'post', 60);
  const browsePrep = addFunction('prepare browse', `msg._benchStart=Date.now(); msg.nodeId='${rootNodeId}'; return msg;`, 60);
  const browseId = id();
  nodes.push({ id: browseId, type: 'tier0-opcua-browse', z: tabId, name: 'real browse', connection: connectionId, rootNodeId, recursive: true, maxDepth: '3', maxNodes: String(browseNodeLimit), variablesOnly: true, browseBatchSize: '100', referencesPerNode: '1000', attributeBatchSize: '200', outputMode: 'all', pageSize: '500', x: 570, y: 60, wires: [[]] });
  const browseSummary = addFunction('browse result', `const items=msg.payload||[]; msg.payload={operation:'browse',points:items.length,elapsedMs:Date.now()-msg._benchStart}; return msg;`, 60);
  wire(browseHttp, browsePrep); wire(browsePrep, browseId); wire(browseId, browseSummary); wire(browseSummary, responseId);

  const selectedBrowseHttp = addHttp('browse-selected', 'get', 100);
  const selectedBrowseId = id();
  nodes.push({ id: selectedBrowseId, type: 'tier0-opcua-browse', z: tabId, name: 'saved tree selection', connection: connectionId, rootNodeId, selectedNodes: selectedBrowsePoints, recursive: true, variablesOnly: true, maxDepth: '3', maxNodes: String(browseNodeLimit), browseBatchSize: '100', referencesPerNode: '1000', attributeBatchSize: '200', outputMode: 'all', pageSize: '500', x: 570, y: 100, wires: [[]] });
  const selectedBrowseSummary = addFunction('selected browse result', `msg.payload={operation:'browse-selected',points:(msg.payload||[]).length,nodeIds:(msg.payload||[]).map(x=>x.nodeId),source:msg.opcua&&msg.opcua.source}; return msg;`, 100);
  wire(selectedBrowseHttp, selectedBrowseId); wire(selectedBrowseId, selectedBrowseSummary); wire(selectedBrowseSummary, responseId);

  const readHttp = addHttp('read', 'post', 140);
  const readPrep = addFunction('prepare JSON read points', pointSource.replace('return msg;', "msg.payload=JSON.stringify(msg.payload); return msg;"), 140);
  const readId = id();
  nodes.push({ id: readId, type: 'tier0-opcua-read', z: tabId, name: 'real JSON batch read', connection: connectionId, nodeId: '', batchSize: String(batchSize), outputMode: 'batch', x: 660, y: 140, wires: [[]] });
  const readSummary = addFunction('read result', `const items=msg.payload||[]; msg.payload={operation:'read',points:items.length,good:items.filter(x=>x.statusCode==='Good').length,elapsedMs:Date.now()-msg._benchStart,clientDiagnostics:msg.opcua&&msg.opcua.clientDiagnostics}; return msg;`, 140);
  wire(readHttp, readPrep); wire(readPrep, readId); wire(readId, readSummary); wire(readSummary, responseId);

  const subscribeHttp = addHttp('subscribe', 'post', 220);
  const subscribePrep = addFunction(
    'prepare subscribe points',
    pointSource.replace('return msg;', "msg.opcua={command:'replace'}; return msg;"),
    220
  );
  nodes.push({ id: subscribeId, type: 'tier0-opcua-subscribe', z: tabId, name: 'real massive subscribe', connection: connectionId, nodeId: '', publishingInterval: '100', lifetimeCount: '600', maxKeepAliveCount: '20', maxNotificationsPerPublish: '0', samplingInterval: '100', queueSize: '2', discardOldest: true, deadbandType: 'none', deadbandValue: '0', timestampMode: 'source', batchSize: String(batchSize), maxItemsPerSubscription: String(maxItemsPerSubscription), callbackQueueSize: String(Math.max(50000, pointCount * 4)), callbackBatchSize: '500', callbackFlushIntervalMs: '50', queueMode: 'all', overflowPolicy: 'drop-oldest', outputMode: 'batch', reconnectInterval: '5000', x: 800, y: 220, wires: [[subscribeResultId]] });
  nodes.push({ id: subscribeResultId, type: 'function', z: tabId, name: 'subscription collector', outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 1030, y: 220, wires: [[responseId]], func: `
if (msg.opcua && msg.opcua.operation === 'subscription-status') {
  if (msg.payload.command === 'recover') {
    const state=flow.get('benchState')||{};
    state.recovery={...msg.payload,opcua:msg.opcua,at:Date.now()};
    flow.set('benchState',state);
    return null;
  }
  if (msg.payload.command === 'replace') {
    flow.set('benchState', {count:msg._benchCount,received:0,changed:{},final:{},finalFloor:Number.MAX_SAFE_INTEGER});
  }
  msg.payload={operation:'subscribe',command:msg.payload.command,desired:msg.payload.desired,monitored:msg.payload.monitored,subscriptionCount:msg.payload.subscriptionCount,subscriptionIds:msg.payload.subscriptionIds,elapsedMs:Date.now()-msg._benchStart};
  return msg;
}
const state=flow.get('benchState');
if (!state || !msg.opcua) return null;
const changes=Array.isArray(msg.payload) ? msg.payload : [{...msg.opcua,value:msg.payload}];
for (const change of changes) {
  if (!change.nodeId) continue;
  state.received += 1;
  if (Number(change.value) >= 1000000) state.changed[change.nodeId]=true;
  if (Number(change.value) >= state.finalFloor) state.final[change.nodeId]=true;
}
state.queue=msg.opcua.queue||state.queue;
flow.set('benchState',state);
return null;` });
  wire(subscribeHttp, subscribePrep); wire(subscribePrep, subscribeId);

  const writeHttp = addHttp('write', 'post', 300);
  const writePrep = addFunction('prepare writes', `
const input=msg.payload||{};
const count=Math.min(Number(input.count)||${pointCount},${pointCount});
const round=Math.max(0,Number(input.round)||0);
const floor=1000000+round*count;
const state=flow.get('benchState')||{count,received:0,changed:{},final:{}};
state.finalFloor=floor; state.final={}; flow.set('benchState',state);
msg._benchStart=Date.now(); msg._benchCount=count;
const rows=['nodeId,value,dataType'];
for(let index=0;index<count;index+=1){
  const nodeId='ns=${namespace};s=Factory.Area'+String(Math.floor(index/500)).padStart(3,'0')+'.Point'+String(index).padStart(6,'0');
  rows.push(nodeId+','+(floor+index)+',Double');
}
msg.payload=rows.join('\\n');
return msg;`, 300);
  const writeId = id();
  nodes.push({ id: writeId, type: 'tier0-opcua-write', z: tabId, name: 'real CSV batch write', connection: connectionId, nodeId: '', dataType: 'Double', batchSize: String(batchSize), outputMode: 'batch', x: 580, y: 300, wires: [[]] });
  const writeSummary = addFunction('write result', `const items=msg.payload||[]; msg.payload={operation:'write',points:items.length,good:items.filter(x=>x.statusCode==='Good').length,elapsedMs:Date.now()-msg._benchStart,clientDiagnostics:msg.opcua&&msg.opcua.clientDiagnostics}; return msg;`, 300);
  wire(writeHttp, writePrep); wire(writePrep, writeId); wire(writeId, writeSummary); wire(writeSummary, responseId);

  const resultsHttp = addHttp('results', 'get', 380);
  const resultsId = addFunction('subscription results', `const state=flow.get('benchState')||{}; msg.payload={operation:'results',count:state.count||0,received:state.received||0,distinctChanged:Object.keys(state.changed||{}).length,distinctFinalChanged:Object.keys(state.final||{}).length,finalFloor:state.finalFloor,queue:state.queue||{},recovery:state.recovery||null}; return msg;`, 380);
  wire(resultsHttp, resultsId); wire(resultsId, responseId);

  const armHttp = addHttp('arm', 'post', 420);
  const armId = addFunction('arm external writes', `const input=msg.payload||{}; const state=flow.get('benchState')||{}; state.finalFloor=Number(input.floor)||Number.MAX_SAFE_INTEGER; state.final={}; flow.set('benchState',state); msg.payload={operation:'arm',finalFloor:state.finalFloor}; return msg;`, 420);
  wire(armHttp, armId); wire(armId, responseId);

  const clearHttp = addHttp('clear', 'post', 460);
  const clearPrep = addFunction('clear subscription', `msg._benchStart=Date.now(); msg.opcua={command:'clear'}; return msg;`, 460);
  wire(clearHttp, clearPrep); wire(clearPrep, subscribeId);

  const errorId = id();
  const errorResponseId = addFunction('benchmark error', `msg.statusCode=500; msg.payload={operation:'error',message:msg.error&&msg.error.message||'unknown error'}; return msg;`, 540);
  nodes.push({ id: errorId, type: 'catch', z: tabId, name: 'benchmark errors', scope: [browseId, selectedBrowseId, readId, writeId, subscribeId], uncaught: false, x: 350, y: 540, wires: [[errorResponseId]] });
  wire(errorResponseId, responseId);

  return {
    id: tabId,
    label: `Codex OPC UA runtime benchmark ${pointCount} ${routeRoot.split('_').at(-1)}`,
    disabled: false,
    info: 'Temporary flow created by test/nodered.integration.js',
    env: [],
    nodes,
    configs: [{ id: connectionId, type: 'tier0-opcua-connection', name: 'benchmark connection', endpoint, securityMode: 'None', securityPolicy: 'None', user: '', certificate: '', privateKey: '', requestedSessionTimeout: '5000', requestTimeout: '1000', connectivityCheckInterval: '500', reconnectInterval: '200', maxReconnectInterval: '1000', nodeIdCacheSize: String(nodeIdCacheSize), commandQueueSize: '256' }],
  };
}

async function waitForFinal(count) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    result = await request(`${adminUrl}${routeRoot}/results`);
    if (result.distinctFinalChanged === count) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Subscription final values did not converge: ${JSON.stringify(result)}`);
}

async function waitForRecovery(count) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    result = await request(`${adminUrl}${routeRoot}/results`);
    if (result.recovery?.rebuilt === true && result.recovery?.monitored === count) {
      return result.recovery;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Subscription did not recover: ${JSON.stringify(result)}`);
}

async function main() {
  const totalStarted = performance.now();
  const before = await request(`${adminUrl}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
  const beforeIds = before.flows.map((item) => item.id).sort();
  let server = await startFixture();
  const flow = createFlow(server.endpoint, server.namespace, server.rootNodeId);
  let deployed = false;
  let deployedFlowId = null;
  let externalWriter = null;
  const nodeRedPid = findNodeRedPid();
  const startSample = processSample(nodeRedPid);
  let peakRssMb = startSample?.rssMb || 0;
  let memoryPhase = 'deploy';
  const phasePeakRssMb = {};
  const sampleMemory = () => {
    const rssMb = processSample(nodeRedPid)?.rssMb || 0;
    peakRssMb = Math.max(peakRssMb, rssMb);
    phasePeakRssMb[memoryPhase] = Math.max(phasePeakRssMb[memoryPhase] || 0, rssMb);
  };
  const setMemoryPhase = (phase) => {
    memoryPhase = phase;
    sampleMemory();
  };
  const sampler = setInterval(() => {
    sampleMemory();
  }, 20);

  try {
    const deployStarted = performance.now();
    await jsonRequest(`${adminUrl}/flow`, 'POST', flow);
    deployed = true;
    const deployedState = await request(`${adminUrl}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
    const deployedTabs = deployedState.flows.filter((item) => item.type === 'tab' && item.label === flow.label);
    assert.equal(deployedTabs.length, 1, 'Temporary Node-RED tab was not deployed uniquely');
    deployedFlowId = deployedTabs[0].id;
    const deployMs = ms(deployStarted);

    setMemoryPhase('browse-flow');
    const browse = await jsonRequest(`${adminUrl}${routeRoot}/browse`, 'POST', { count: pointCount });
    assert(browse.points >= pointCount, 'Live Browse omitted fixture process points');

    const countVariables = (tree) => (tree.nodeClass === 'Variable' ? 1 : 0) +
      (tree.children || []).reduce((total, child) => total + countVariables(child), 0);
    let editorTree = null;
    let editorVariables = null;
    if (editorBrowseTest) {
      setMemoryPhase('browse-editor-tree');
      editorTree = await jsonRequest(`${adminUrl}/opcua-client/browse`, 'POST', {
        connectionId: flow.configs[0].id,
        rootNodeId: server.rootNodeId,
        maxDepth: 3,
        maxNodes: browseNodeLimit,
        attributeBatchSize: 200,
      });
      editorVariables = countVariables(editorTree.tree);
      assert(editorVariables >= pointCount, 'Editor Browse omitted fixture process points');
    }
    const selectedBrowse = await request(`${adminUrl}${routeRoot}/browse-selected`);
    assert.equal(selectedBrowse.points, Math.min(3, pointCount));
    assert.equal(selectedBrowse.source, 'browse-selection');

    const readLatencies = [];
    let finalRead;
    setMemoryPhase('read');
    for (let round = 0; round < readRounds; round += 1) {
      const result = await jsonRequest(`${adminUrl}${routeRoot}/read`, 'POST', { count: pointCount });
      assert.equal(result.points, pointCount);
      assert.equal(result.good, pointCount);
      readLatencies.push(result.elapsedMs);
      finalRead = result;
    }

    setMemoryPhase('subscribe');
    const subscription = await jsonRequest(`${adminUrl}${routeRoot}/subscribe`, 'POST', { count: pointCount });
    assert.equal(subscription.desired, pointCount);
    assert.equal(subscription.monitored, pointCount);
    assert.equal(
      subscription.subscriptionCount,
      Math.ceil(pointCount / maxItemsPerSubscription),
      'Point set was not sharded into the expected number of subscriptions'
    );

    let reconnectRecovery = null;
    if (reconnectTest) {
      setMemoryPhase('reconnect');
      await stopFixture(server);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      server = await startFixture();
      reconnectRecovery = await waitForRecovery(pointCount);
    }

    const writeLatencies = [];
    let finalWrite;
    setMemoryPhase('write-and-notify');
    if (externalWriteTest) {
      externalWriter = new OpcUaClient({
        endpoint: server.endpoint,
        securityMode: 'None',
        requestTimeout: 10000,
        nodeIdCacheSize: pointCount + 100,
      });
      await externalWriter.connect();
    }
    for (let round = 0; round < writeRounds; round += 1) {
      if (externalWriteTest) {
        const floor = 1000000 + round * pointCount;
        await jsonRequest(`${adminUrl}${routeRoot}/arm`, 'POST', { floor });
        const writes = Array.from({ length: pointCount }, (_, index) => ({
          nodeId: `ns=${server.namespace};s=Factory.Area${String(Math.floor(index / 500)).padStart(3, '0')}.Point${String(index).padStart(6, '0')}`,
          value: floor + index,
          dataType: 'Double',
        }));
        const started = performance.now();
        const results = await externalWriter.writeMany(writes, batchSize);
        const elapsedMs = ms(started);
        assert.equal(results.length, pointCount);
        assert.equal(results.filter((item) => item.statusCode === 'Good').length, pointCount);
        writeLatencies.push(elapsedMs);
        finalWrite = { clientDiagnostics: externalWriter.getDiagnostics() };
      } else {
        const result = await jsonRequest(`${adminUrl}${routeRoot}/write`, 'POST', { count: pointCount, round });
        assert.equal(result.points, pointCount);
        assert.equal(result.good, pointCount);
        writeLatencies.push(result.elapsedMs);
        finalWrite = result;
      }
    }

    setMemoryPhase('final-convergence');
    const subscriptionResult = await waitForFinal(pointCount);
    const nodeRedDiagnostics = externalWriteTest
      ? finalRead?.clientDiagnostics
      : finalWrite?.clientDiagnostics;
    assert.equal(nodeRedDiagnostics.connectionUsage.consumerCount, 5);
    assert.equal(nodeRedDiagnostics.connectionUsage.automaticIdleDisconnect, false);
    setMemoryPhase('clear');
    await jsonRequest(`${adminUrl}${routeRoot}/clear`, 'POST', {});
    const endSample = processSample(nodeRedPid);
    const clockTicks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100;

    console.log(JSON.stringify({
      runtime: 'Node-RED deployed flow',
      points: pointCount,
      batchSize,
      rounds: { read: readRounds, write: writeRounds },
      writeDriver: externalWriteTest ? 'external native client' : 'Node-RED CSV Write node',
      durationsMs: {
        deploy: deployMs,
        browse: browse.elapsedMs,
        readP50: percentile(readLatencies, 0.5),
        readP95: percentile(readLatencies, 0.95),
        writeP50: percentile(writeLatencies, 0.5),
        writeP95: percentile(writeLatencies, 0.95),
        subscribe: subscription.elapsedMs,
        total: ms(totalStarted),
      },
      notifications: subscriptionResult,
      editorTree: editorTree
        ? { nodes: editorTree.total, variables: editorVariables }
        : { skipped: true, reason: 'OPCUA_NODERED_EDITOR_BROWSE=0' },
      selectedBrowse,
      reconnectRecovery,
      clientDiagnostics: nodeRedDiagnostics,
      writerDiagnostics: externalWriteTest ? finalWrite?.clientDiagnostics : undefined,
      nodeRedProcess: {
        pid: nodeRedPid,
        rssBeforeMb: startSample?.rssMb,
        rssAfterMb: endSample?.rssMb,
        peakRssMb,
        phasePeakRssMb,
        cpuMs: startSample && endSample ? Math.round(((endSample.ticks - startSample.ticks) / clockTicks) * 1000) : null,
      },
    }, null, 2));
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  } finally {
    clearInterval(sampler);
    if (externalWriter) await externalWriter.disconnect().catch(() => {});
    if (deployed) {
      try {
        if (!deployedFlowId) {
          const current = await request(`${adminUrl}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
          deployedFlowId = current.flows.find((item) => item.type === 'tab' && item.label === flow.label)?.id;
        }
        if (deployedFlowId) await request(`${adminUrl}/flow/${deployedFlowId}`, { method: 'DELETE' });
      } catch (error) {
        console.error(`Flow cleanup failed: ${error.message}`);
      }
    }
    await stopFixture(server);
    const after = await request(`${adminUrl}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
    const afterIds = after.flows.map((item) => item.id).sort();
    assert.deepEqual(afterIds, beforeIds, 'Original Node-RED flow set was not restored');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
