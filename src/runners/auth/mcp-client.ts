// src/runners/auth/mcp-client.ts
// Minimal JSON-RPC POST helper for API-key validation. authEndpointUrl
// enforces HTTPS for remote endpoints and permits plaintext only on loopback.

import * as http from 'http';
import * as https from 'https';

import { ONE_MCP_MAX_RESPONSE_BYTES } from '../../config/one-mcp';
import { authEndpointUrl } from '../../shared/auth';

type Rec = Record<string, unknown>;

// Resolves with the HTTP status and body for every server response; rejects only
// for transport failures. validate-key.ts classifies the status AND the body.
//
// The body is BOUNDED, and that became load-bearing when the body stopped being
// diagnostic text and became a decision input: validate-key parses `error.code`
// out of a 401 to decide whether to clear this machine's credential, and it now
// does so from a detached background worker with nowhere to report a failure.
// Accumulating an unbounded response from a remote server into that process's
// memory is not something to leave to the server's good behaviour.
//
// The cap is ONE_MCP_MAX_RESPONSE_BYTES (config/one-mcp.ts, 64 KiB) — already
// this repo's ceiling for a One MCP response, and independently the server's own
// documented request-body cap for this very endpoint (MCP_SERVER_INSTRUCTIONS.md
// §8, `413 payload_too_large` above 64 KiB), so the two sides agree by accident
// of neither having invented a number. A truncated body cannot parse as the
// error envelope and cannot match the `"result":` probe, so an over-cap response
// classifies as UNREACHABLE — the safe direction, and the one that never clears
// a credential on a response this client could not read whole.
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
      let truncated = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (truncated) return;
        responseBody += chunk;
        if (Buffer.byteLength(responseBody, 'utf8') <= ONE_MCP_MAX_RESPONSE_BYTES) return;
        // Stop reading AND stop the transfer. Resolving here rather than
        // rejecting keeps the status code, which is still the honest thing the
        // server said; the truncated body then fails every recogniser above.
        truncated = true;
        const statusCode = res.statusCode || 0;
        req.destroy();
        resolve({ statusCode, body: responseBody.slice(0, ONE_MCP_MAX_RESPONSE_BYTES) });
      });
      res.on('end', () => {
        if (!truncated) resolve({ statusCode: res.statusCode || 0, body: responseBody });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
