'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECURITY_POLICY_URIS,
  matchingEndpoints,
  normalizeConnectionOptions,
  normalizePathList,
} = require('../lib/security');

test('normalizes strict secure connection options', () => {
  const options = normalizeConnectionOptions({
    endpoint: ' opc.tcp://server:4840 ',
    securityMode: 'SignAndEncrypt',
    securityPolicy: SECURITY_POLICY_URIS.Basic256Sha256,
    certificate: 'client.der',
    privateKey: 'client-key.pem',
    trustedCertificates: 'server.der\nca.der;server.der',
  });
  assert.equal(options.endpoint, 'opc.tcp://server:4840');
  assert.equal(options.securityPolicy, 'Basic256Sha256');
  assert.equal(options.securityPolicyUri, SECURITY_POLICY_URIS.Basic256Sha256);
  assert.deepEqual(options.trustedCertificates, ['server.der', 'ca.der']);
});

test('rejects invalid or insecure security combinations', () => {
  assert.throws(
    () => normalizeConnectionOptions({
      endpoint: 'opc.tcp://server:4840', securityMode: 'Sign', securityPolicy: 'None',
    }),
    (error) => error.code === 'OPCUA_INVALID_SECURITY_CONFIGURATION'
  );
  assert.throws(
    () => normalizeConnectionOptions({
      endpoint: 'opc.tcp://server:4840', securityMode: 'None', securityPolicy: 'Basic256Sha256',
    }),
    /SecurityMode None requires SecurityPolicy None/
  );
  assert.throws(
    () => normalizeConnectionOptions({
      endpoint: 'opc.tcp://server:4840', securityMode: 'SignAndEncrypt',
      securityPolicy: 'Basic256Sha256', certificate: 'client.der', privateKey: 'key.pem',
    }),
    /trusted server or CA certificate/
  );
});

test('matches discovered endpoints by mode, policy, and identity type', () => {
  const endpoints = [
    {
      endpointUrl: 'opc.tcp://server:4840', securityMode: 'None',
      securityPolicyUri: SECURITY_POLICY_URIS.None,
      userIdentityTokens: [{ tokenType: 'Anonymous' }],
    },
    {
      endpointUrl: 'opc.tcp://server:4840', securityMode: 'SignAndEncrypt',
      securityPolicyUri: SECURITY_POLICY_URIS.Basic256Sha256,
      userIdentityTokens: [{ tokenType: 'Anonymous' }, { tokenType: 'Username' }],
    },
  ];
  const matches = matchingEndpoints(endpoints, {
    securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', user: 'operator',
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].securityMode, 'SignAndEncrypt');
  assert.deepEqual(normalizePathList([' a.der ', '', 'a.der', 'b.der']), ['a.der', 'b.der']);
});
