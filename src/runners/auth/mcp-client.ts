// src/runners/auth/mcp-client.ts
// Minimal JSON-RPC POST helper for wizard API-key validation. authEndpointUrl
// enforces HTTPS for remote endpoints and permits plaintext only on loopback.

import * as http from 'http';
import * as https from 'https';

import { authEndpointUrl } from '../../shared/auth';

type Rec = Record<string, unknown>;

// Resolves with the HTTP status and body for every server response; rejects only
// for transport failures. The wizard classifies 401/403 as an invalid key.
export function mcpPost(endpoint: string, payload: Rec, bearer: string, timeoutMs = 15000): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = authEndpointUrl(endpoint);
    const body = JSON.stringify(payload);
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
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: responseBody }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
