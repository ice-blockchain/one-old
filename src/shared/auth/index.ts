// Canonical API-key auth helpers. The wizard validates a submitted key with an
// authenticated MCP `tools/list` request, then simple-auth persists that key in
// one.json.auth.

import * as net from 'net';

import { AUTH_ENABLED, DEFAULT_ENDPOINT } from '../../config/auth';
import { oneSettingsPath } from '../one-settings';
import { isLocallyAuthenticated } from './simple-auth';

export { readSimpleAuth, isLocallyAuthenticated, writeSimpleAuth, clearAuthentication } from './simple-auth';

export function isLoopbackHostname(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(host);
  // 0.0.0.0 is the wildcard address, not loopback. Keep the plaintext-HTTP
  // exception restricted to genuine loopback development endpoints.
  if (ipVersion === 4) return host.startsWith('127.');
  if (ipVersion === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return host === 'localhost' || host === 'localhost.';
}

export function authEndpointUrl(endpoint: string): URL {
  let url: URL;
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

export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || DEFAULT_ENDPOINT;
}

// Production auth is enabled by default. The process override remains useful
// for explicit operational and hermetic-test opt-outs.
export function authEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env.TRAFFIC_ONE_AUTH ?? '').trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'on' || override === 'yes') return true;
  if (override === '0' || override === 'false' || override === 'off' || override === 'no') return false;
  return AUTH_ENABLED;
}

export function authSatisfied(env: NodeJS.ProcessEnv = process.env): boolean {
  return !authEnforced(env) || isLocallyAuthenticated(env);
}

// Entry hooks use this only as a fallback context when the canonical wizard
// cannot yet open. Key intake and persistence are owned by the wizard.
export function authRequiredMessage(env: NodeJS.ProcessEnv = process.env): string {
  return [
    'Traffic One authentication is required before this plugin can be used.',
    '',
    'Open the Traffic One onboarding wizard and enter the Traffic One API key.',
    `The wizard validates it through authenticated MCP tools/list and stores it under auth in ${oneSettingsPath(env)}.`,
    'Do not pass the key through a shell command or edit the auth state manually.',
  ].join('\n');
}
