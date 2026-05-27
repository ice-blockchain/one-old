'use strict';

const http = require('http');
const https = require('https');

const { extractToolText } = require('./_helpers.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function authEndpointUrl(...args) {
  return require('./authEndpointUrl.cjs').authEndpointUrl(...args);
}
function buildMcpPayload(...args) {
  return require('./buildMcpPayload.cjs').buildMcpPayload(...args);
}

function mcpRequest(endpoint, toolName, bearer, args = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = authEndpointUrl(endpoint);
    const body = JSON.stringify(buildMcpPayload(toolName, args));
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`HTTP ${res.statusCode || 'unknown'}`);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        if (/"error"\s*:/.test(responseBody)) {
          reject(new Error('MCP error response'));
          return;
        }
        const text = extractToolText(responseBody);
        if (text === null) {
          reject(new Error('MCP response did not include tool text content'));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('MCP tool text content was not JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { mcpRequest };
