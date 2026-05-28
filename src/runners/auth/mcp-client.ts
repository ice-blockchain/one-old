// src/runners/auth/mcp-client.ts
// Minimal MCP JSON-RPC client for the auth endpoint (tools/call over HTTP(S)).
// authEndpointUrl (shared/auth) enforces HTTPS for remote + loopback-only HTTP,
// so credentials never leave for a plaintext remote. Ported 1:1 from
// scripts/traffic-one-auth/{mcpRequest,buildMcpPayload}.cjs + extractToolText.

import * as http from 'http';
import * as https from 'https';

import { authEndpointUrl } from '../../shared/auth';

type Rec = Record<string, unknown>;

export type McpError = Error & { statusCode?: number };

export function buildMcpPayload(toolName: string, args: Rec = {}): Rec {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };
}

export function extractToolText(responseBody: string): string | null {
  const tryParse = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text) as Rec;
      const result = parsed && typeof parsed.result === 'object' ? parsed.result as Rec : null;
      const content = result ? result.content : null;
      if (Array.isArray(content) && content[0] && typeof (content[0] as Rec).text === 'string') {
        return (content[0] as Rec).text as string;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(responseBody);
  if (direct !== null) return direct;

  for (const line of responseBody.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const parsed = tryParse(line.slice('data:'.length).trim());
    if (parsed !== null) return parsed;
  }

  return null;
}

export function mcpRequest(endpoint: string, toolName: string, bearer: string, args: Rec = {}, timeoutMs = 15000): Promise<Rec> {
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
          const error: McpError = new Error(`HTTP ${res.statusCode || 'unknown'}`);
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
          resolve(JSON.parse(text) as Rec);
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
