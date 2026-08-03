// src/runners/auth/validate-key.ts
// Intake-time API-key validation for the onboarding wizard. The submitted key is
// checked against the fixed AUTH endpoint (`.../traffic-one-mcp/mcp`) —
// NOT the public first-look report endpoint, which accepts anything and can never
// reject a bad key.
//
// HOW: a standard `tools/list` JSON-RPC call carrying the key as Bearer. The
// gated endpoint's whole auth model is its Unkey Bearer gate — an invalid key is
// bounced 401/403 BEFORE method dispatch, a valid key gets a 2xx `result`. Do NOT
// substitute another MCP method: validation proves that the Bearer key can reach
// the authenticated MCP tool surface.
// Anything that is neither a 2xx result nor a 401/403 (timeout, DNS, non-HTTPS,
// 5xx) is treated as unreachable. The wizard fails CLOSED on both non-ok cases:
// a key is only stored once the gate confirms it.

import { DEFAULT_ENDPOINT } from '../../config/one-mcp';
import { mcpPost } from './mcp-client';

export type KeyValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid-api-key' | 'auth-endpoint-unreachable'; error?: string };

interface ValidateApiKeyOptions {
  endpoint?: string;
  timeoutMs?: number;
}

export async function validateApiKey(
  apiKey: string,
  options: ValidateApiKeyOptions = {},
): Promise<KeyValidation> {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, reason: 'invalid-api-key' };
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 10000;
  let statusCode: number;
  let body: string;
  try {
    ({ statusCode, body } = await mcpPost(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, key, timeoutMs));
  } catch (error) {
    return { ok: false, reason: 'auth-endpoint-unreachable', error: (error as Error)?.message };
  }
  if (statusCode === 401 || statusCode === 403) return { ok: false, reason: 'invalid-api-key' };
  if (statusCode >= 200 && statusCode < 300 && /"result"\s*:/.test(body)) return { ok: true };
  return { ok: false, reason: 'auth-endpoint-unreachable', error: `HTTP ${statusCode || 'unknown'}` };
}
