'use strict';

const SECURITY_POLICY_URIS = Object.freeze({
  None: 'http://opcfoundation.org/UA/SecurityPolicy#None',
  Basic256Sha256: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
});

const SECURITY_MODES = new Set(['None', 'Sign', 'SignAndEncrypt']);

function configurationError(message) {
  const error = new Error(message);
  error.code = 'OPCUA_INVALID_SECURITY_CONFIGURATION';
  return error;
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
  securityPolicyName,
};
