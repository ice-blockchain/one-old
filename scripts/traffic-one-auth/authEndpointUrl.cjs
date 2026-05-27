'use strict';

const { isLoopbackHostname } = require('./_helpers.cjs');

function authEndpointUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid Traffic One MCP auth endpoint: ${endpoint}`);
  }
  if (url.username || url.password) {
    throw new Error('Traffic One MCP auth endpoint must not include URL credentials.');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
  throw new Error('Refusing to send Traffic One credentials to a non-HTTPS MCP auth endpoint. Use HTTPS for remote endpoints; HTTP is allowed only for loopback local development.');
}

module.exports = { authEndpointUrl };
