'use strict';

const assert = require('node:assert/strict');
const { OpcUaClient, discoverEndpoints } = require('../lib/client');
const { matchingEndpoints } = require('../lib/security');

async function main() {
  const options = {
    endpoint: process.env.OPCUA_SECURE_ENDPOINT,
    securityMode: process.env.OPCUA_SECURITY_MODE || 'SignAndEncrypt',
    securityPolicy: process.env.OPCUA_SECURITY_POLICY || 'Basic256Sha256',
    user: process.env.OPCUA_USERNAME || '',
    password: process.env.OPCUA_PASSWORD || '',
    certificate: process.env.OPCUA_CLIENT_CERTIFICATE,
    privateKey: process.env.OPCUA_CLIENT_PRIVATE_KEY,
    privateKeyPassword: process.env.OPCUA_CLIENT_PRIVATE_KEY_PASSWORD || '',
    applicationUri: process.env.OPCUA_CLIENT_APPLICATION_URI || '',
    trustedCertificates: process.env.OPCUA_TRUSTED_CERTIFICATES || '',
    revocationList: process.env.OPCUA_REVOCATION_LIST || '',
    requestTimeout: Number(process.env.OPCUA_REQUEST_TIMEOUT) || 10000,
  };
  if (!options.endpoint || !options.certificate || !options.privateKey ||
      !options.trustedCertificates) {
    throw new Error(
      'Set OPCUA_SECURE_ENDPOINT, OPCUA_CLIENT_CERTIFICATE, ' +
      'OPCUA_CLIENT_PRIVATE_KEY, and OPCUA_TRUSTED_CERTIFICATES'
    );
  }

  const endpoints = await discoverEndpoints(options);
  const matches = matchingEndpoints(endpoints, options);
  assert(matches.length > 0, 'No discovered endpoint matches the requested security and identity');

  const client = new OpcUaClient(options);
  let subscriptionId;
  try {
    await client.connect();
    const values = await client.readMany([{
      nodeId: 'ns=0;i=2258',
    }]);
    assert.equal(values[0].statusCode, 'Good');
    const connection = client.getDiagnostics().connection;
    assert.equal(connection.connected, true);
    assert.equal(connection.securityMode, options.securityMode);
    assert(connection.securityPolicyUri.endsWith(`#${options.securityPolicy}`));

    let notify;
    const notification = new Promise((resolve) => { notify = resolve; });
    const subscription = await client.createSubscription({
      publishingInterval: 250,
      callbackQueueSize: 100,
    }, (batch) => {
      if (batch.changes?.length) notify(batch.changes[0]);
    });
    subscriptionId = subscription.subscriptionId;
    const monitored = await client.addMonitoredItems(
      subscriptionId,
      [{ nodeId: 'ns=0;i=2258', samplingInterval: 250, queueSize: 2 }],
      {},
      100
    );
    assert.equal(monitored[0].statusCode, 'Good');
    let notificationTimer;
    await Promise.race([
      notification,
      new Promise((_, reject) => {
        notificationTimer = setTimeout(
          () => reject(new Error('Timed out waiting for a secure subscription notification')),
          5000
        );
      }),
    ]);
    clearTimeout(notificationTimer);
    console.log(JSON.stringify({
      secureIntegration: 'passed',
      endpoint: options.endpoint,
      securityMode: connection.securityMode,
      securityPolicyUri: connection.securityPolicyUri,
      identityType: connection.identityType,
    }, null, 2));
  } finally {
    if (subscriptionId != null) {
      await client.deleteSubscription(subscriptionId).catch(() => {});
    }
    await client.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
