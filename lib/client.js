'use strict';

const { EventEmitter } = require('events');
const { chunks } = require('./points');
const { loadAddon } = require('./native');

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

function effectiveBatchSize(requested, serverLimit) {
  const configured = Number.isFinite(Number(requested)) && Number(requested) > 0
    ? Math.floor(Number(requested))
    : 500;
  const limit = Number(serverLimit);
  return Number.isFinite(limit) && limit > 0
    ? Math.min(configured, Math.floor(limit))
    : configured;
}

class OpcUaClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = { ...options };
    this.handle = null;
    this.connecting = null;
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
    };
  }

  async connect() {
    if (this.closed) throw new Error('OPC UA client is closed');
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
    const addon = loadAddon();
    const token = ++this.connectionToken;
    this.connectionState = 'connecting';
    let handle;
    try {
      handle = await addon.connectAsync(
        this.options,
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
    return this.#invoke('browseAsync', options);
  }

  async readMany(points, batchSize = 500) {
    const results = [];
    await this.connect();
    const effective = effectiveBatchSize(
      batchSize, this.diagnostics.operationLimits?.maxNodesPerRead
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
      batchSize, this.diagnostics.operationLimits?.maxNodesPerWrite
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
      batchSize, this.diagnostics.operationLimits?.maxMonitoredItemsPerCall
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
      batchSize, this.diagnostics.operationLimits?.maxMonitoredItemsPerCall
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

  #refreshDiagnostics() {
    if (this.handle == null) return;
    const addon = loadAddon();
    if (typeof addon.getClientDiagnostics !== 'function') return;
    try {
      const nativeDiagnostics = addon.getClientDiagnostics(this.handle) || {};
      this.diagnostics = {
        ...nativeDiagnostics,
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
    } else if (state.terminal) {
      void this.#replaceTerminalClient(token, state);
    }
  }

  async #replaceTerminalClient(token, state) {
    if (this.closed || token !== this.connectionToken) return;
    this.connectionToken += 1;
    this.supervisorDiagnostics.terminalReplacements += 1;
    const handle = this.handle;
    this.handle = null;
    this.connectionState = 'failed';
    if (handle != null) {
      try { await loadAddon().disconnectAsync(handle); } catch {}
    }
    if (!this.closed) {
      const error = new Error(`OPC UA connection failed: ${state.statusCode || 'Unknown'}`);
      error.code = 'OPCUA_CONNECTION_FAILED';
      this.emit('fault', error);
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this.connecting) return;
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

module.exports = { OpcUaClient, effectiveBatchSize, normalizeNotificationBatch };
