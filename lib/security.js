'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const SECURITY_POLICY_URIS = Object.freeze({
  None: 'http://opcfoundation.org/UA/SecurityPolicy#None',
  Basic256Sha256: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
  Aes128_Sha256_RsaOaep: 'http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep',
  Aes256_Sha256_RsaPss: 'http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss',
});

const SECURITY_MODES = new Set(['None', 'Sign', 'SignAndEncrypt']);

function configurationError(message, code = 'OPCUA_INVALID_SECURITY_CONFIGURATION', cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function readSecurityFile(filePath, label, readFileSync = fs.readFileSync) {
  try {
    return readFileSync(filePath);
  } catch (error) {
    throw configurationError(
      `Cannot read OPC UA ${label}: ${filePath}`,
      'OPCUA_SECURITY_FILE_UNREADABLE',
      error
    );
  }
}

function parseCertificate(buffer, label, X509Certificate = crypto.X509Certificate) {
  try {
    return new X509Certificate(buffer);
  } catch (error) {
    throw configurationError(
      `Invalid OPC UA ${label}`,
      'OPCUA_CERTIFICATE_INVALID',
      error
    );
  }
}

function applicationUris(certificate) {
  const output = [];
  const expression = /(?:^|,\s*)URI:((?:"[^"]+")|[^,]+)/g;
  for (const match of String(certificate.subjectAltName || '').matchAll(expression)) {
    const value = match[1].replace(/^"|"$/g, '').trim();
    if (value && !output.includes(value)) output.push(value);
  }
  return output;
}

function validateCertificateTime(certificate, label, now = Date.now()) {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (Number.isFinite(validFrom) && now < validFrom) {
    throw configurationError(
      `OPC UA ${label} is not valid before ${certificate.validFrom}`,
      'OPCUA_CERTIFICATE_NOT_YET_VALID'
    );
  }
  if (Number.isFinite(validTo) && now > validTo) {
    throw configurationError(
      `OPC UA ${label} expired at ${certificate.validTo}`,
      'OPCUA_CERTIFICATE_EXPIRED'
    );
  }
}

function loadPrivateKey(buffer, passphrase, createPrivateKey = crypto.createPrivateKey) {
  const password = passphrase ? String(passphrase) : undefined;
  const attempts = [
    { key: buffer, passphrase: password },
    { key: buffer, format: 'der', type: 'pkcs8', passphrase: password },
    { key: buffer, format: 'der', type: 'pkcs1', passphrase: password },
  ];
  let lastError;
  for (const options of attempts) {
    try {
      return createPrivateKey(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw configurationError(
    'Invalid OPC UA client private key or key password',
    'OPCUA_PRIVATE_KEY_INVALID',
    lastError
  );
}

function certificateSummary(certificate, uri) {
  const publicKey = certificate.publicKey;
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    fingerprint256: certificate.fingerprint256,
    applicationUri: uri || null,
    publicKeyType: publicKey?.asymmetricKeyType || null,
    modulusLength: publicKey?.asymmetricKeyDetails?.modulusLength || null,
  };
}

function normalizePathList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n|;/);
  return [...new Set(source.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function securityPolicyName(value) {
  const policy = String(value || 'None').trim();
  if (SECURITY_POLICY_URIS[policy]) return policy;
  const match = Object.entries(SECURITY_POLICY_URIS).find(([, uri]) => uri === policy);
  return match?.[0] || policy;
}

function normalizeConnectionOptions(options = {}) {
  const normalized = {
    ...options,
    endpoint: String(options.endpoint || '').trim(),
    securityMode: String(options.securityMode || 'None').trim(),
    securityPolicy: securityPolicyName(options.securityPolicy),
    certificate: String(options.certificate || '').trim(),
    privateKey: String(options.privateKey || '').trim(),
    applicationUri: String(options.applicationUri || '').trim(),
    trustedCertificates: normalizePathList(
      options.trustedCertificates ?? options.trustList
    ),
    revocationList: normalizePathList(options.revocationList),
  };

  if (!normalized.endpoint) throw configurationError('OPC UA endpoint is required');
  if (!SECURITY_MODES.has(normalized.securityMode)) {
    throw configurationError(`Unsupported OPC UA security mode: ${normalized.securityMode}`);
  }
  if (!SECURITY_POLICY_URIS[normalized.securityPolicy]) {
    throw configurationError(`Unsupported OPC UA security policy: ${normalized.securityPolicy}`);
  }
  if (normalized.securityMode === 'None') {
    if (normalized.securityPolicy !== 'None') {
      throw configurationError('SecurityMode None requires SecurityPolicy None');
    }
  } else {
    if (normalized.securityPolicy === 'None') {
      throw configurationError(`${normalized.securityMode} requires a non-None security policy`);
    }
    if (!normalized.certificate) {
      throw configurationError('Secure OPC UA connections require a client certificate');
    }
    if (!normalized.privateKey) {
      throw configurationError('Secure OPC UA connections require a client private key');
    }
    if (!normalized.trustedCertificates.length) {
      throw configurationError('Secure OPC UA connections require at least one trusted server or CA certificate');
    }
  }

  normalized.securityPolicyUri = SECURITY_POLICY_URIS[normalized.securityPolicy];
  return normalized;
}

function preflightConnectionSecurity(options = {}, dependencies = {}) {
  const normalized = normalizeConnectionOptions(options);
  const runtime = {
    readFileSync: dependencies.readFileSync || fs.readFileSync,
    X509Certificate: dependencies.X509Certificate || crypto.X509Certificate,
    createPrivateKey: dependencies.createPrivateKey || crypto.createPrivateKey,
    now: dependencies.now == null ? Date.now() : Number(dependencies.now),
  };
  if (normalized.securityMode === 'None') {
    return {
      ...normalized,
      securityPreflight: { enabled: false, policy: normalized.securityPolicy },
    };
  }

  const certificate = parseCertificate(
    readSecurityFile(normalized.certificate, 'client certificate', runtime.readFileSync),
    'client certificate',
    runtime.X509Certificate
  );
  validateCertificateTime(certificate, 'client certificate', runtime.now);

  const uris = applicationUris(certificate);
  const applicationUri = normalized.applicationUri || (uris.length === 1 ? uris[0] : '');
  if (!applicationUri) {
    throw configurationError(
      'The OPC UA client certificate must contain one Application URI or Application URI must be configured',
      'OPCUA_CERTIFICATE_URI_MISSING'
    );
  }
  if (!uris.includes(applicationUri)) {
    throw configurationError(
      `Configured Application URI does not match the client certificate: ${applicationUri}`,
      'OPCUA_CERTIFICATE_URI_MISMATCH'
    );
  }

  const privateKey = loadPrivateKey(
    readSecurityFile(normalized.privateKey, 'client private key', runtime.readFileSync),
    normalized.privateKeyPassword,
    runtime.createPrivateKey
  );
  if (!certificate.checkPrivateKey(privateKey)) {
    throw configurationError(
      'The OPC UA client private key does not match the client certificate',
      'OPCUA_PRIVATE_KEY_MISMATCH'
    );
  }

  const keyType = certificate.publicKey?.asymmetricKeyType || '';
  const modulusLength = Number(certificate.publicKey?.asymmetricKeyDetails?.modulusLength) || 0;
  if (!keyType.startsWith('rsa')) {
    throw configurationError(
      `OPC UA ${normalized.securityPolicy} requires an RSA client certificate`,
      'OPCUA_CERTIFICATE_KEY_TYPE_UNSUPPORTED'
    );
  }
  if (modulusLength > 0 && modulusLength < 2048) {
    throw configurationError(
      `OPC UA client certificate RSA key is too short: ${modulusLength} bits; at least 2048 bits required`,
      'OPCUA_CERTIFICATE_KEY_TOO_SHORT'
    );
  }

  const trust = normalized.trustedCertificates.map((filePath) => {
    const trusted = parseCertificate(
      readSecurityFile(filePath, 'trusted certificate', runtime.readFileSync),
      `trusted certificate: ${filePath}`,
      runtime.X509Certificate
    );
    validateCertificateTime(trusted, `trusted certificate: ${filePath}`, runtime.now);
    return certificateSummary(trusted);
  });

  return {
    ...normalized,
    applicationUri,
    securityPreflight: {
      enabled: true,
      policy: normalized.securityPolicy,
      clientCertificate: certificateSummary(certificate, applicationUri),
      trustedCertificates: trust,
    },
  };
}

function endpointIdentityTypes(endpoint) {
  return [...new Set((endpoint?.userIdentityTokens || []).map((token) => token.tokenType))];
}

function matchingEndpoints(endpoints, options = {}) {
  const mode = String(options.securityMode || 'None');
  const policy = securityPolicyName(options.securityPolicy);
  const identityType = String(options.identityType || (options.user ? 'Username' : 'Anonymous'));
  return (Array.isArray(endpoints) ? endpoints : []).filter((endpoint) => (
    endpoint.securityMode === mode &&
    securityPolicyName(endpoint.securityPolicyUri || endpoint.securityPolicy) === policy &&
    endpointIdentityTypes(endpoint).includes(identityType)
  ));
}

module.exports = {
  SECURITY_POLICY_URIS,
  matchingEndpoints,
  normalizeConnectionOptions,
  normalizePathList,
  preflightConnectionSecurity,
  securityPolicyName,
};
