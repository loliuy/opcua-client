'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECURITY_POLICY_URIS,
  matchingEndpoints,
  normalizeConnectionOptions,
  normalizePathList,
  preflightConnectionSecurity,
} = require('../lib/security');

function preflightDependencies(options = {}) {
  class Certificate {
    constructor(buffer) {
      const name = buffer.toString();
      if (name === 'invalid-certificate') throw new Error('invalid');
      this.name = name;
      this.subject = `CN=${name}`;
      this.issuer = 'CN=Test CA';
      this.validFrom = options.validFrom || 'Jan 01 00:00:00 2026 GMT';
      this.validTo = options.validTo || 'Jan 01 00:00:00 2036 GMT';
      this.fingerprint256 = `fingerprint:${name}`;
      this.subjectAltName = name === 'client-certificate'
        ? 'URI:urn:tier0:test:opcua-client, DNS:localhost'
        : 'DNS:server';
      this.publicKey = {
        asymmetricKeyType: options.keyType || 'rsa',
        asymmetricKeyDetails: { modulusLength: options.modulusLength || 2048 },
      };
    }

    checkPrivateKey(key) {
      return this.name === 'client-certificate' && key.name === 'client-private-key';
    }
  }

  return {
    now: Date.parse('2027-01-01T00:00:00Z'),
    readFileSync(filePath) {
      const content = options.files?.[filePath] || ({
        'client.der': 'client-certificate',
        'client-key.pem': 'client-private-key',
        'server.der': 'server-certificate',
      })[filePath];
      if (!content) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      return Buffer.from(content);
    },
    X509Certificate: Certificate,
    createPrivateKey({ key }) {
      const name = key.toString();
      if (name === 'invalid-private-key') throw new Error('invalid key');
      return { name };
    },
  };
}

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

test('supports WinCC V8.1 AES policies and exact endpoint matching', () => {
  for (const policy of ['Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss']) {
    const options = normalizeConnectionOptions({
      endpoint: 'opc.tcp://wincc:4862',
      securityMode: 'SignAndEncrypt',
      securityPolicy: policy,
      certificate: 'client.der',
      privateKey: 'client-key.pem',
      trustedCertificates: ['server.der'],
    });
    assert.equal(options.securityPolicyUri, SECURITY_POLICY_URIS[policy]);
    assert.equal(matchingEndpoints([{
      securityMode: 'SignAndEncrypt',
      securityPolicyUri: SECURITY_POLICY_URIS[policy],
      userIdentityTokens: [{ tokenType: 'Anonymous' }],
    }], options).length, 1);
  }
});

test('preflights certificate validity, Application URI, key pair, trust, and RSA strength', () => {
  const options = preflightConnectionSecurity({
    endpoint: 'opc.tcp://wincc:4862',
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Aes256_Sha256_RsaPss',
    certificate: 'client.der',
    privateKey: 'client-key.pem',
    trustedCertificates: ['server.der'],
  }, preflightDependencies());

  assert.equal(options.applicationUri, 'urn:tier0:test:opcua-client');
  assert.equal(options.securityPreflight.enabled, true);
  assert.equal(options.securityPreflight.clientCertificate.modulusLength, 2048);
  assert.equal(options.securityPreflight.trustedCertificates.length, 1);

  assert.throws(() => preflightConnectionSecurity({
    ...options,
    applicationUri: 'urn:wrong',
  }, preflightDependencies()), (error) => error.code === 'OPCUA_CERTIFICATE_URI_MISMATCH');

  assert.throws(() => preflightConnectionSecurity({
    ...options,
    privateKey: 'wrong-key.pem',
  }, preflightDependencies({ files: { 'wrong-key.pem': 'other-key' } })),
  (error) => error.code === 'OPCUA_PRIVATE_KEY_MISMATCH');

  assert.throws(() => preflightConnectionSecurity(options,
    preflightDependencies({ modulusLength: 1024 })),
  (error) => error.code === 'OPCUA_CERTIFICATE_KEY_TOO_SHORT');
});
