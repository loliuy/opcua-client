'use strict';

const { EventEmitter } = require('events');
const { chunks } = require('./points');
const { loadAddon } = require('./native');
const { preflightConnectionSecurity } = require('./security');
const { SIEMENS_WINCC_DEFAULTS, isSiemensWinCC } = require('./compatibility');

function normalizeNotificationBatch(notification) {
  if (notification && Array.isArray(notification.changes)) {
    if (!notification.diagnostics) notification.diagnostics = {};
    return notification;
  }
  return {
    changes: notification == null ? [] : [notification],
    diagnostics: {},
  };
}

function effectiveBatchSize(requested, serverLimit, fallbackLimit) {
  const configured = Number.isFinite(Number(requested)) && Number(requested) > 0
    ? Math.floor(Number(requested))
    : 500;
  const limit = Number(serverLimit);
  if (Number.isFinite(limit) && limit > 0) {
    return Math.min(configured, Math.floor(limit));
  }
  const fallback = Number(fallbackLimit);
  return Number.isFinite(fallback) && fallback > 0
    ? Math.min(configured, Math.floor(fallback))
    : configured;
}

class OpcUaClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = { ...options };
    this.handle = null;
    this.connecting = null;
    this.replacing = null;
    this.closed = false;
    this.connectionState = 'idle';
    this.connectionToken = 0;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.supervisorDiagnostics = {
      clientGeneration: 0,
      reconnectAttempts: 0,
      reconnectSuccesses: 0,
      terminalReplacements: 0,
      reconnectStartedAt: null,
      lastReconnectDurationMs: 0,
    };
    this.lastState = {
      state: 'idle',
      connected: false,
      statusCode: 'Good',
    };
    this.diagnostics = {
      operationLimits: {},
      nodeIdCache: {},
      connection: {},
      compatibility: this.#compatibilityDiagnostics(),
    };
  }

  async connect() {
    if (this.closed) throw new Error('OPC UA client is closed');
    if (this.replacing) {
      const error = new Error('OPC UA client is replacing a failed connection');
      error.code = 'OPCUA_RECONNECTING';
      throw error;
    }
    if (this.handle != null) {
      if (this.connectionState === 'connected') return this.handle;
      const error = new Error(`OPC UA client is ${this.connectionState}`);
      error.code = 'OPCUA_RECONNECTING';
      throw error;
    }
    if (this.connecting) return this.connecting;

    this.connecting = this.#connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
      if (!this.closed && this.handle == null && this.connectionState === 'failed') {
        this.#scheduleReconnect();
      }
    }
  }

  async #connect() {
    const options = preflightConnectionSecurity(this.options);
    this.diagnostics.securityPreflight = options.securityPreflight;
    const addon = loadAddon();
    const token = ++this.connectionToken;
    this.connectionState = 'connecting';
    let handle;
    try {
      handle = await addon.connectAsync(
        options,
        (state) => this.#onNativeState(token, state)
      );
    } catch (error) {
      if (token === this.connectionToken && !this.closed) {
        this.connectionState = 'failed';
        this.lastState = {
          state: 'failed', connected: false, terminal: true,
          statusCode: error.message, reason: 'connect-failed',
        };
        this.emit('state', this.lastState);
        this.emit('fault', error);
        this.#scheduleReconnect();
      }
      throw error;
    }
    if (this.closed || token !== this.connectionToken) {
      await addon.disconnectAsync(handle).catch(() => {});
      throw new Error('OPC UA connection attempt was superseded');
    }
    this.handle = handle;
    this.supervisorDiagnostics.clientGeneration = token;
    if (this.supervisorDiagnostics.reconnectStartedAt != null) {
      this.supervisorDiagnostics.reconnectSuccesses += 1;
      this.supervisorDiagnostics.lastReconnectDurationMs =
        Date.now() - this.supervisorDiagnostics.reconnectStartedAt;
      this.supervisorDiagnostics.reconnectStartedAt = null;
    }
    this.#refreshDiagnostics();
    if (this.connectionState !== 'connected') {
      this.connectionState = 'connected';
      this.lastState = {
        state: 'connected', connected: true, terminal: false,
        statusCode: 'Good', reason: 'connect-complete',
        sessionGeneration: this.diagnostics.connection?.sessionGeneration || 1,
      };
      this.emit('state', this.lastState);
    }
    this.reconnectAttempt = 0;
    return handle;
  }

  async disconnect() {
    this.closed = true;
    this.connectionState = 'closing';
    this.connectionToken += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const connecting = this.connecting;
    if (connecting) {
      try { await connecting; } catch {}
    }
    const replacing = this.replacing;
    if (replacing) {
      try { await replacing; } catch {}
    }
    const handle = this.handle;
    this.handle = null;
    if (handle != null) {
      try {
        await loadAddon().disconnectAsync(handle);
      } finally {
        this.connectionState = 'closed';
      }
    }
    this.lastState = { state: 'closed', connected: false, statusCode: 'Good' };
    this.emit('state', this.lastState);
  }

  async browse(options) {
    const items = await this.#invoke('browseAsync', options);
    const browse = {
      truncated: Boolean(items?.truncated),
      truncationReason: items?.truncationReason || null,
      serviceCalls: Number(items?.serviceCalls) || 0,
      browseBatchSize: Number(items?.browseBatchSize) || 1,
      releasedContinuationPoints: Number(items?.releasedContinuationPoints) || 0,
      failures: Array.isArray(items?.browseFailures) ? items.browseFailures : [],
    };
    this.diagnostics.browse = browse;
    if (Array.isArray(items)) {
      for (const field of [
        'truncated', 'truncationReason', 'serviceCalls', 'browseBatchSize',
        'releasedContinuationPoints', 'browseFailures',
      ]) delete items[field];
      Object.defineProperty(items, 'diagnostics', {
        configurable: true,
        enumerable: false,
        value: browse,
      });
    }
    return items;
  }

  async readMany(points, batchSize = 500) {
    const results = [];
    await this.connect();
    const effective = effectiveBatchSize(
      batchSize, this.diagnostics.operationLimits?.maxNodesPerRead,
      this.#compatibilityBatchFallback()
    );
    for (const batch of chunks(points, effective)) {
      results.push(...await this.#invoke('readManyAsync', batch));
    }
    return results;
  }

  async writeMany(points, batchSize = 500) {
    const results = [];
    await this.connect();
    const effective = effectiveBatchSize(
      batchSize, this.diagnostics.operationLimits?.maxNodesPerWrite,
      this.#compatibilityBatchFallback()
    );
    for (const batch of chunks(points, effective)) {
      results.push(...await this.#invoke('writeManyAsync', batch));
    }
    return results;
  }

  async createSubscription(options, callback) {
    return this.#invoke('createSubscriptionAsync', options, (notification) => {
      callback(normalizeNotificationBatch(notification));
    });
  }

  async addMonitoredItems(subscriptionId, points, options, batchSize = 500) {
    const results = [];
    await this.connect();
    const effective = effectiveBatchSize(
      batchSize, this.diagnostics.operationLimits?.maxMonitoredItemsPerCall,
      this.#compatibilityBatchFallback()
    );
    for (const batch of chunks(points, effective)) {
      results.push(...await this.#invoke(
        'addMonitoredItemsAsync', subscriptionId, batch, options
      ));
    }
    return results;
  }

  async removeMonitoredItems(subscriptionId, monitoredItemIds, batchSize = 500) {
    const results = [];
    await this.connect();
    const effective = effectiveBatchSize(
      batchSize, this.diagnostics.operationLimits?.maxMonitoredItemsPerCall,
      this.#compatibilityBatchFallback()
    );
    for (const batch of chunks(monitoredItemIds, effective)) {
      results.push(...await this.#invoke('removeMonitoredItemsAsync', subscriptionId, batch));
    }
    return results;
  }

  async deleteSubscription(subscriptionId) {
    return this.#invoke('deleteSubscriptionAsync', subscriptionId);
  }

  async validateSubscription(subscriptionId) {
    return this.#invoke('validateSubscriptionAsync', subscriptionId);
  }

  getState() {
    return { ...this.lastState };
  }

  getDiagnostics() {
    this.#refreshDiagnostics();
    return this.diagnostics;
  }

  #compatibilityBatchFallback() {
    return isSiemensWinCC(this.options.compatibilityProfile)
      ? SIEMENS_WINCC_DEFAULTS.requestBatchSize
      : 0;
  }

  #compatibilityDiagnostics() {
    const siemensWincc = isSiemensWinCC(this.options.compatibilityProfile);
    return {
      profile: siemensWincc ? 'siemens-wincc' : 'standard',
      requestBatchFallback: siemensWincc
        ? SIEMENS_WINCC_DEFAULTS.requestBatchSize
        : null,
    };
  }

  #refreshDiagnostics() {
    if (this.handle == null) return;
    const addon = loadAddon();
    if (typeof addon.getClientDiagnostics !== 'function') return;
    try {
      const nativeDiagnostics = addon.getClientDiagnostics(this.handle) || {};
      this.diagnostics = {
        ...nativeDiagnostics,
        browse: this.diagnostics.browse,
        securityPreflight: this.diagnostics.securityPreflight,
        compatibility: this.#compatibilityDiagnostics(),
        connection: {
          ...(nativeDiagnostics.connection || {}),
          supervisor: { ...this.supervisorDiagnostics },
        },
      };
    } catch {
      // The connection may have closed between reading the handle and querying diagnostics.
    }
  }

  #onNativeState(token, state) {
    if (this.closed || token !== this.connectionToken || !state) return;
    if (state.state === 'subscription-inactive') {
      this.emit('state', { ...state, clientGeneration: token });
      return;
    }
    this.connectionState = state.state || (state.connected ? 'connected' : 'reconnecting');
    this.lastState = { ...state, clientGeneration: token };
    this.emit('state', this.lastState);
    if (state.connected) {
      this.reconnectAttempt = 0;
      this.#refreshDiagnostics();
    } else if (state.terminal && !this.replacing) {
      const replacing = this.#replaceTerminalClient(token, state);
      this.replacing = replacing;
      void replacing.then(
        () => {
          if (this.replacing === replacing) this.replacing = null;
        },
        () => {
          if (this.replacing === replacing) this.replacing = null;
        }
      );
    }
  }

  async #replaceTerminalClient(token, state) {
    if (this.closed || token !== this.connectionToken) return;
    this.connectionToken += 1;
    this.supervisorDiagnostics.terminalReplacements += 1;
    const handle = this.handle;
    this.connectionState = 'replacing';
    if (handle != null) {
      try { await loadAddon().disconnectAsync(handle); } catch {}
    }
    if (this.handle === handle) this.handle = null;
    if (!this.closed) {
      this.connectionState = 'failed';
      const error = new Error(`OPC UA connection failed: ${state.statusCode || 'Unknown'}`);
      error.code = 'OPCUA_CONNECTION_FAILED';
      this.emit('fault', error);
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.closed || this.handle != null || this.reconnectTimer || this.connecting) return;
    const base = Math.max(100, Number(this.options.reconnectInterval) || 5000);
    const maximum = Math.max(base, Number(this.options.maxReconnectInterval) || 30000);
    const exponential = Math.min(maximum, base * (2 ** this.reconnectAttempt));
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.max(100, Math.round(exponential * jitter));
    this.reconnectAttempt += 1;
    this.supervisorDiagnostics.reconnectAttempts += 1;
    if (this.supervisorDiagnostics.reconnectStartedAt == null) {
      this.supervisorDiagnostics.reconnectStartedAt = Date.now();
    }
    this.connectionState = 'backoff';
    this.lastState = {
      state: 'backoff', connected: false, recoverable: true,
      reason: 'new-client', attempt: this.reconnectAttempt, delay,
    };
    this.emit('state', this.lastState);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  async #invoke(method, ...args) {
    const handle = await this.connect();
    try {
      return await loadAddon()[method](handle, ...args);
    } catch (error) {
      if (/disconnect|connection|session|channel/i.test(error.message)) {
        this.emit('fault', error);
      }
      throw error;
    }
  }
}

async function discoverEndpoints(options) {
  const source = typeof options === 'string' ? { endpoint: options } : { ...options };
  const endpoint = String(source.endpoint || '').trim();
  if (!endpoint) {
    const error = new Error('OPC UA endpoint is required');
    error.code = 'OPCUA_INVALID_SECURITY_CONFIGURATION';
    throw error;
  }
  return loadAddon().discoverEndpointsAsync({
    endpoint,
    requestTimeout: Number(source.requestTimeout) || 10000,
  });
}

module.exports = {
  OpcUaClient,
  discoverEndpoints,
  effectiveBatchSize,
  normalizeNotificationBatch,
};
