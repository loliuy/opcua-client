'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionRegistry, connectionSignature } = require('../lib/connection-registry');

test('detects equivalent configurations without exposing credentials', () => {
  const registry = new ConnectionRegistry();
  const firstOptions = {
    endpoint: 'opc.tcp://wincc:4862',
    securityMode: 'SignAndEncrypt',
    user: 'operator',
    password: 'secret',
    trustedCertificates: ['/pki/server.der'],
  };
  const secondOptions = {
    password: 'secret',
    user: 'operator',
    securityMode: 'SignAndEncrypt',
    endpoint: 'opc.tcp://wincc:4862',
    trustedCertificates: ['/pki/server.der'],
  };

  const first = registry.register(firstOptions);
  const second = registry.register(secondOptions);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(first.diagnostics(), {
    equivalentConfigurations: 2,
    duplicateConfiguration: true,
    activeConfigurations: 2,
  });
  assert.equal(connectionSignature(firstOptions).includes('secret'), false);
  assert.equal(
    connectionSignature(firstOptions),
    connectionSignature({ ...firstOptions, password: 'changed', reconnectInterval: 10000 })
  );

  assert.equal(first.unregister(), true);
  assert.equal(first.unregister(), false);
  assert.deepEqual(second.diagnostics(), {
    equivalentConfigurations: 1,
    duplicateConfiguration: false,
    activeConfigurations: 1,
  });
  second.unregister();
  assert.equal(registry.size, 0);
});

test('uses endpoint, security, and user identity as the Session governance boundary', () => {
  const registry = new ConnectionRegistry();
  const base = {
    endpoint: 'opc.tcp://wincc:4862',
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Basic256Sha256',
    user: 'operator',
    password: 'one',
    reconnectInterval: 5000,
  };
  const registrations = [
    registry.register(base),
    registry.register({ ...base, endpoint: 'opc.tcp://wincc:4863' }),
    registry.register({ ...base, user: 'engineer' }),
    registry.register({ ...base, securityMode: 'Sign' }),
  ];

  assert.ok(registrations.every((registration) => registration.duplicate === false));
  assert.equal(registry.size, registrations.length);
  registrations.forEach((registration) => registration.unregister());
});

test('warns about extra Sessions even when only password or timeout settings differ', () => {
  const registry = new ConnectionRegistry();
  const base = {
    endpoint: 'opc.tcp://wincc:4862',
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Basic256Sha256',
    user: 'operator',
    password: 'one',
    reconnectInterval: 5000,
  };
  const first = registry.register(base);
  const passwordChange = registry.register({ ...base, password: 'two' });
  const timeoutChange = registry.register({ ...base, reconnectInterval: 10000 });

  assert.equal(first.duplicate, false);
  assert.equal(passwordChange.duplicate, true);
  assert.equal(timeoutChange.duplicate, true);
  assert.equal(first.diagnostics().equivalentConfigurations, 3);
  first.unregister();
  passwordChange.unregister();
  timeoutChange.unregister();
});
