'use strict';

const { createHash } = require('node:crypto');
const FAILURE_LIMIT = 100;
const POINT_MESSAGES = {
  BadNotReadable: '访问级别不允许读取或订阅该点位',
  BadUserAccessDenied: '当前用户无权执行该操作',
  BadNodeIdUnknown: '服务端找不到该 NodeId',
  BadNodeIdInvalid: 'NodeId 格式无效',
  BadNoCommunication: '服务端无法与该点位的数据源通信',
  BadWaitingForInitialData: '等待该点位的首次数据',
  BadTimeout: '该点位操作超时',
  BadNotWritable: '该点位不允许写入',
  BadTypeMismatch: '写入值类型与点位类型不匹配',
  BadTooManyMonitoredItems: '服务端监控点数量超限',
};

// Output only allowlisted metadata: never forward SDK messages, credentials,
// endpoint URLs, input payloads or raw state/diagnostic objects.
function statusCode(error) {
  const text = String(error?.code || error?.statusCode || error?.message || error || '');
  return /\b(?:Bad[A-Za-z0-9]+|Uncertain[A-Za-z0-9]*|OPCUA_[A-Z_]+)\b/.exec(text)?.[0] || 'OperationFailed';
}

function createDiagnostics(node, config, operation) {
  const recent = new Map();
  let closed = false;
  let interrupted = false;
  const activeFailures = new Set();
  const pendingFailures = new Map();
  let inputs = 0;
  const client = node.connection?.client;
  function emit(level, event, message, details = {}, send) {
    if (closed) return;
    const now = Date.now();
    const failures = details.failures;
    // Different failing points must not be hidden by another batch's throttle.
    const fingerprint = createHash('sha256');
    if (failures) for (const item of failures) {
      fingerprint.update(JSON.stringify([item.nodeId, item.alias, item.statusCode]));
    }
    const key = `${event}:${details.statusCode || ''}:${failures ? fingerprint.digest('hex') : ''}`;
    const previous = recent.get(key);
    if (previous && now - previous.time < 30000) {
      previous.suppressed += 1;
      return;
    }
    const payload = {
      level, event, message, time: new Date(now).toISOString(),
      nodeId: node.id || config.id, connectionId: config.connection, operation,
      retrying: details.retrying === true,
    };
    if (details.statusCode) payload.statusCode = statusCode(details.statusCode);
    if (failures) {
      payload.failures = failures.slice(0, FAILURE_LIMIT).map((item) => {
        const code = statusCode(item.statusCode);
        return {
          ...(typeof item.nodeId === 'string' ? { nodeId: item.nodeId } : {}),
          ...(typeof item.alias === 'string' && item.alias ? { alias: item.alias } : {}),
          statusCode: code,
          message: POINT_MESSAGES[code] || '点位返回非 Good 状态，请根据 statusCode 排查',
        };
      });
      payload.failuresTruncated = failures.length > FAILURE_LIMIT;
      payload.omittedFailures = Math.max(0, failures.length - FAILURE_LIMIT);
    }
    for (const field of ['failed', 'total', 'monitored', 'desired', 'dropped', 'subscriptionId']) {
      if (Number.isFinite(details[field])) payload[field] = details[field];
    }
    for (const field of ['rebuilt', 'dataGapPossible']) {
      if (typeof details[field] === 'boolean') payload[field] = details[field];
    }
    if (previous?.suppressed) payload.suppressed = previous.suppressed;
    if (recent.size >= 128) recent.delete(recent.keys().next().value);
    recent.set(key, { time: now, suppressed: 0 });
    const output = send || (node.send && node.send.bind(node));
    output?.([null, { payload, opcua: { operation: 'diagnostic' } }]);
  }
  function failure(error, send, event = `${operation}_failed`, retrying = false) {
    emit('error', event, `OPC UA ${operation} failed`, { statusCode: statusCode(error), retrying }, send);
  }
  // Background failures have no input message/done callback. Report from the
  // operation node so Catch can scope the error to its flow. Retries belong to
  // one failure episode, reset only by the corresponding recovery.
  function backgroundFailure(error, event, group = 'subscription') {
    if (closed) return;
    if (interrupted) group = 'connection';
    if (activeFailures.has(group)) return;
    if (inputs) {
      if (!pendingFailures.has(group)) pendingFailures.set(group, { error, event });
      return;
    }
    activeFailures.add(group);
    const code = statusCode(error);
    const caught = new Error(`OPC UA ${event}: ${code}`);
    caught.code = code;
    node.error(caught, {
      opcua: {
        operation: 'diagnostic', event, statusCode: code,
        nodeId: node.id || config.id, connectionId: config.connection,
      },
    });
  }
  function recovered(group) {
    activeFailures.delete(group);
    pendingFailures.delete(group);
  }
  function beginInput() {
    inputs++;
  }
  function endInput(error) {
    if (error) {
      // done(error) already reports this input's failure to Catch.
      for (const group of pendingFailures.keys()) activeFailures.add(group);
      pendingFailures.clear();
    }
    inputs--;
    if (!inputs) {
      const pending = [...pendingFailures];
      pendingFailures.clear();
      for (const [group, failure] of pending) {
        backgroundFailure(failure.error, failure.event, group);
      }
    }
  }
  function results(items, send, descriptors) {
    const failed = items.filter((item) => item.statusCode && item.statusCode !== 'Good');
    const failures = failed.map((item) => ({
      nodeId: item.nodeId,
      alias: item.alias ?? descriptors?.get(item.nodeId)?.alias,
      statusCode: item.statusCode,
    }));
    if (failed.length) emit('warn', 'points_failed', 'Some OPC UA points returned a non-Good status', {
      failed: failed.length, total: items.length, statusCode: statusCode(failed[0].statusCode),
      failures,
    }, send);
    return failed.length;
  }
  const onFault = (error) => {
    interrupted = true;
    backgroundFailure(error, 'connection_fault', 'connection');
    emit('warn', 'connection_fault', 'OPC UA connection fault', { statusCode: statusCode(error), retrying: true });
  };
  const onState = (state) => {
    if (!state) return;
    if (state.state === 'connected') {
      recovered('connection');
      if (interrupted) {
        recent.clear();
        emit('info', 'connection_restored', 'OPC UA connection restored; subscription recovery may still be pending');
      }
      interrupted = false;
    } else if (['reconnecting', 'backoff', 'failed'].includes(state.state)) {
      interrupted = true;
      if (state.state === 'failed') {
        backgroundFailure(state.statusCode || 'OPCUA_CONNECTION_FAILED', 'connection_failed', 'connection');
      }
      emit(state.state === 'failed' ? 'error' : 'warn', `connection_${state.state}`,
        'OPC UA connection unavailable; recovery pending', {
          retrying: true, ...(state.statusCode && state.statusCode !== 'Good' ? { statusCode: statusCode(state.statusCode) } : {}),
        });
    }
  };
  client?.on?.('fault', onFault);
  client?.on?.('state', onState);
  node.on('close', () => {
    closed = true;
    recent.clear();
    activeFailures.clear();
    pendingFailures.clear();
    client?.removeListener?.('fault', onFault);
    client?.removeListener?.('state', onState);
  });
  return { emit, failure, backgroundFailure, recovered, beginInput, endInput, results };
}

module.exports = { createDiagnostics, statusCode };
