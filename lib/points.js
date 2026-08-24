'use strict';

const DEFAULTS = Object.freeze({
  samplingInterval: 1000,
  queueSize: 10,
  discardOldest: true,
});

const INTEGER_RANGES = Object.freeze({
  SByte: [-128n, 127n],
  Byte: [0n, 255n],
  Int16: [-32768n, 32767n],
  UInt16: [0n, 65535n],
  Int32: [-2147483648n, 2147483647n],
  UInt32: [0n, 4294967295n],
  Int64: [-9223372036854775808n, 9223372036854775807n],
  UInt64: [0n, 18446744073709551615n],
});

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function booleanValue(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || /^(true|1)$/i.test(String(value))) return true;
  if (value === 0 || /^(false|0)$/i.test(String(value))) return false;
  throw new Error(`Invalid Boolean value: ${value}`);
}

function normalizeIndexRange(value, fallback = '') {
  const source = value == null || value === '' ? fallback : value;
  const text = String(source == null ? '' : source).trim();
  if (!text) return '';
  const dimensions = text.split(',').map((dimension) => dimension.trim());
  for (const dimension of dimensions) {
    if (!/^\d+(?::\d+)?$/.test(dimension)) {
      throw new Error(`Invalid OPC UA IndexRange: ${text}`);
    }
    const bounds = dimension.split(':').map(Number);
    if (bounds.some((bound) => !Number.isSafeInteger(bound) || bound > 0xffffffff) ||
        (bounds.length === 2 && bounds[0] > bounds[1])) {
      throw new Error(`Invalid OPC UA IndexRange: ${text}`);
    }
  }
  return dimensions.join(',');
}

function normalizePoint(input, defaults = {}) {
  const source = typeof input === 'string' ? { nodeId: input } : { ...(input || {}) };
  const nodeId = String(source.nodeId || source.topic || '').trim();
  if (!nodeId) throw new Error('Point is missing nodeId');

  const point = {
    ...source,
    nodeId,
    samplingInterval: positiveNumber(
      source.samplingInterval,
      positiveNumber(defaults.samplingInterval, DEFAULTS.samplingInterval)
    ),
    queueSize: Math.floor(positiveNumber(
      source.queueSize,
      positiveNumber(defaults.queueSize, DEFAULTS.queueSize)
    )),
    discardOldest: booleanValue(
      source.discardOldest,
      booleanValue(defaults.discardOldest, true)
    ),
  };

  const indexRange = normalizeIndexRange(
    source.indexRange ?? source.range,
    defaults.indexRange ?? defaults.range
  );
  if (indexRange) point.indexRange = indexRange;
  else {
    delete point.indexRange;
  }
  delete point.range;

  if (point.alias != null) point.alias = String(point.alias);
  else delete point.alias;
  if (point.dataType != null) point.dataType = String(point.dataType);
  else delete point.dataType;
  if (point.deadbandType == null || point.deadbandType === '') delete point.deadbandType;
  else {
    const deadbandType = String(point.deadbandType).toLowerCase();
    const normalizedDeadbandType = deadbandType === 'a' ? 'absolute' :
      (deadbandType === 'p' ? 'percent' : deadbandType);
    if (!['none', 'absolute', 'percent'].includes(normalizedDeadbandType)) {
      throw new Error(`Invalid OPC UA deadband type: ${point.deadbandType}`);
    }
    point.deadbandType = normalizedDeadbandType;
  }
  if (point.deadbandValue == null || point.deadbandValue === '') delete point.deadbandValue;
  else {
    point.deadbandValue = Number(point.deadbandValue);
    if (!Number.isFinite(point.deadbandValue) || point.deadbandValue < 0) {
      throw new Error(`Invalid OPC UA deadband value: ${source.deadbandValue}`);
    }
  }
  point.enabled = booleanValue(point.enabled, true);
  return point;
}

function normalizePoints(inputs, defaults = {}, options = {}) {
  if (!Array.isArray(inputs)) throw new Error('Point list must be an array');

  const duplicateMode = options.duplicateMode || 'last';
  const points = new Map();
  const errors = [];

  inputs.forEach((input, index) => {
    try {
      const point = normalizePoint(input, defaults);
      if (point.enabled === false) return;
      if (points.has(point.nodeId) && duplicateMode === 'error') {
        throw new Error(`Duplicate nodeId: ${point.nodeId}`);
      }
      if (!points.has(point.nodeId) || duplicateMode !== 'first') {
        points.set(point.nodeId, point);
      }
    } catch (error) {
      errors.push({ index, error: error.message, input });
    }
  });

  if (errors.length && options.allowInvalid !== true) {
    const error = new Error(`Invalid point list: ${errors.length} item(s) failed validation`);
    error.items = errors;
    throw error;
  }

  return { points: [...points.values()], errors };
}

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  fields.push(value.trim());
  return fields;
}

function forEachCsvLine(text, callback) {
  const source = String(text).replace(/^\uFEFF/, '');
  let start = 0;
  let lineNumber = 0;
  while (start <= source.length) {
    let end = source.indexOf('\n', start);
    if (end === -1) end = source.length;
    const line = source.slice(start, end).replace(/\r$/, '');
    lineNumber += 1;
    if (line.trim() && !line.trimStart().startsWith('#')) callback(line, lineNumber);
    if (end === source.length) break;
    start = end + 1;
  }
}

function parseCsv(text) {
  let headers;
  const rows = [];
  forEachCsvLine(text, (line) => {
    if (!headers) {
      headers = parseCsvLine(line).map((header) => header.trim());
      if (!headers.includes('nodeId')) throw new Error('CSV header must contain nodeId');
      return;
    }
    const values = parseCsvLine(line);
    const row = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = values[index] ?? '';
    }
    rows.push(row);
  });
  return rows;
}

function parsePointPayload(payload, format = 'auto') {
  if (Array.isArray(payload)) return payload;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '').trim();
  if (!text) return [];

  const selected = format === 'auto'
    ? (text.startsWith('[') || text.startsWith('{') ? 'json' : 'csv')
    : format;

  if (selected === 'json') {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [parsed];
  }
  if (selected === 'csv') return parseCsv(text);
  throw new Error(`Unsupported point-list format: ${selected}`);
}

function looksLikePointList(payload) {
  if (Array.isArray(payload)) return true;
  if (payload && typeof payload === 'object' && Array.isArray(payload.items)) return true;
  if (payload == null || (typeof payload !== 'string' && !Buffer.isBuffer(payload))) return false;
  const text = (Buffer.isBuffer(payload) ? payload.toString('utf8') : payload)
    .replace(/^\uFEFF/, '')
    .trimStart();
  return text.startsWith('[') || text.startsWith('{') ||
    /^nodeId(?:\s*,|\s*\r?\n)/i.test(text);
}

function normalizePointPayload(payload, defaults = {}, options = {}) {
  const parsed = parsePointPayload(payload, options.format || 'auto');
  return normalizePoints(parsed, defaults, options);
}

function messagePoints(msg, staticNodeId, defaults = {}, options = {}) {
  let payload;
  if (looksLikePointList(msg.payload)) payload = msg.payload;
  else if (Array.isArray(msg.items)) payload = msg.items;
  else if (options.configuredPayload) payload = options.configuredPayload;

  if (payload != null) {
    return normalizePointPayload(payload, defaults, options).points;
  }

  const nodeId = staticNodeId || msg.nodeId || msg.topic;
  if (!nodeId) throw new Error('Missing OPC UA nodeId or point list');
  return [normalizePoint({
    nodeId,
    alias: msg.alias,
    dataType: msg.dataType,
    indexRange: msg.indexRange ?? msg.range ?? msg.opcua?.indexRange,
    samplingInterval: msg.samplingInterval ?? msg.interval,
    queueSize: msg.queueSize,
    discardOldest: msg.discardOldest,
    deadbandType: msg.deadbandType,
    deadbandValue: msg.deadbandValue,
  }, defaults)];
}

function coerceWriteValue(value, dataType) {
  const type = String(dataType || 'String');
  if (Array.isArray(value)) {
    return value.map((item) => coerceWriteValue(item, type));
  }
  if (value == null) return value;
  if (type === 'Boolean') {
    if (typeof value === 'boolean') return value;
    if (/^(true|1)$/i.test(String(value))) return true;
    if (/^(false|0)$/i.test(String(value))) return false;
    throw new Error(`Invalid Boolean value: ${value}`);
  }
  if (Object.prototype.hasOwnProperty.call(INTEGER_RANGES, type)) {
    let integer;
    if (typeof value === 'bigint') integer = value;
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`Invalid ${type} value: ${value}; use a decimal string for 64-bit integers`);
      }
      integer = BigInt(value);
    } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      integer = BigInt(value.trim());
    } else throw new Error(`Invalid ${type} value: ${value}`);
    const [minimum, maximum] = INTEGER_RANGES[type];
    if (integer < minimum || integer > maximum) {
      throw new Error(`Invalid ${type} value: ${value}; outside OPC UA range`);
    }
    if (type === 'Int64' || type === 'UInt64') {
      return typeof value === 'number' ? value : integer.toString();
    }
    return Number(integer);
  }
  if (type === 'Float' || type === 'Double') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`Invalid ${type} value: ${value}`);
    return number;
  }
  return value;
}

function parseWriteCsvPayload(payload, msg, config) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  let headers;
  let nodeIdIndex = -1;
  let valueIndex = -1;
  let dataTypeIndex = -1;
  let indexRangeIndex = -1;
  let invalid = 0;
  const points = new Map();

  forEachCsvLine(text, (line) => {
    if (!headers) {
      headers = parseCsvLine(line).map((header) => header.trim());
      nodeIdIndex = headers.indexOf('nodeId');
      valueIndex = headers.indexOf('value');
      dataTypeIndex = headers.indexOf('dataType');
      indexRangeIndex = headers.indexOf('indexRange');
      if (indexRangeIndex < 0) indexRangeIndex = headers.indexOf('range');
      if (nodeIdIndex < 0) throw new Error('CSV header must contain nodeId');
      return;
    }

    const values = parseCsvLine(line);
    const nodeId = String(values[nodeIdIndex] || '').trim();
    if (!nodeId) {
      invalid += 1;
      return;
    }
    const dataType = String(
      (dataTypeIndex >= 0 ? values[dataTypeIndex] : '') ||
      msg.dataType || config.dataType || 'String'
    );
    const value = valueIndex >= 0 ? values[valueIndex] : undefined;
    const defaultIndexRange = msg.indexRange ?? msg.range ??
      msg.opcua?.indexRange ?? config.indexRange;
    const indexRange = normalizeIndexRange(
      indexRangeIndex >= 0 ? values[indexRangeIndex] : undefined,
      defaultIndexRange
    );
    points.set(nodeId, {
      nodeId,
      dataType,
      value: coerceWriteValue(value, dataType),
      ...(indexRange ? { indexRange } : {}),
    });
  });

  if (invalid) throw new Error(`Invalid point list: ${invalid} item(s) failed validation`);
  return [...points.values()];
}

function messageWritePoints(msg, config = {}) {
  let points;
  let configuredPoints = false;
  let configuredPointList;
  const defaultIndexRange = msg.indexRange ?? msg.range ??
    msg.opcua?.indexRange ?? config.indexRange;
  if (config.pointList && Array.isArray(msg.payload)) {
    configuredPointList = normalizePointPayload(
      config.pointList, { indexRange: defaultIndexRange }, { format: 'auto' }
    ).points;
  }
  const directNodeId = config.nodeId || msg.nodeId || msg.topic;
  const arrayValue = Array.isArray(msg.payload) && msg.opcua?.pointList !== true && (
    msg.opcua?.arrayValue === true || directNodeId ||
    (configuredPointList?.length === 1 && configuredPointList[0].useInput)
  );
  if (!arrayValue && looksLikePointList(msg.payload)) {
    const inputFormat = config.inputFormat || 'auto';
    const hasTextPayload = typeof msg.payload === 'string' || Buffer.isBuffer(msg.payload);
    const text = Buffer.isBuffer(msg.payload)
      ? msg.payload.toString('utf8').trimStart()
      : typeof msg.payload === 'string' ? msg.payload.trimStart() : '';
    const isCsv = hasTextPayload && (inputFormat === 'csv' ||
      (inputFormat === 'auto' && text && !text.startsWith('[') && !text.startsWith('{')));
    if (isCsv) return parseWriteCsvPayload(msg.payload, msg, config);
    points = normalizePointPayload(
      msg.payload, { indexRange: defaultIndexRange }, { format: inputFormat }
    ).points;
  } else if (msg.payload && typeof msg.payload === 'object' && msg.payload.nodeId) {
    points = normalizePoints([msg.payload], { indexRange: defaultIndexRange }).points;
  } else if (config.pointList) {
    points = configuredPointList ||
      normalizePointPayload(
        config.pointList, { indexRange: defaultIndexRange }, { format: 'auto' }
      ).points;
    configuredPoints = true;
  } else {
    const nodeId = config.nodeId || msg.nodeId || msg.topic;
    if (!nodeId) throw new Error('Missing OPC UA nodeId or point list');
    points = normalizePoints([{
      nodeId,
      value: msg.payload,
      indexRange: defaultIndexRange,
    }]).points;
  }

  return points.map((point) => {
    const dataType = point.dataType || msg.dataType || config.dataType || 'String';
    let value = point.value;
    if (configuredPoints && point.useInput && !Object.prototype.hasOwnProperty.call(point, 'value')) {
      if (points.length === 1) value = msg.payload;
      else if (msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)) {
        if (Object.prototype.hasOwnProperty.call(msg.payload, point.nodeId)) value = msg.payload[point.nodeId];
        else if (point.alias && Object.prototype.hasOwnProperty.call(msg.payload, point.alias)) value = msg.payload[point.alias];
        else throw new Error(`Missing input value for ${point.nodeId}`);
      } else throw new Error(`Missing input value for ${point.nodeId}`);
    }
    return { ...point, dataType, value: coerceWriteValue(value, dataType) };
  });
}

function chunks(items, size) {
  const chunkSize = Math.max(1, Math.floor(positiveNumber(size, 500)));
  const result = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

module.exports = {
  DEFAULTS,
  chunks,
  coerceWriteValue,
  looksLikePointList,
  messagePoints,
  messageWritePoints,
  normalizeIndexRange,
  normalizePoint,
  normalizePointPayload,
  normalizePoints,
  parseCsv,
  parsePointPayload,
};
