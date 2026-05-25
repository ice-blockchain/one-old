#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/mcp';
const AUTH_STATE_VERSION = 1;
const EXPIRY_SKEW_MS = 30 * 1000;
const REMOTE_AUTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return host === '0.0.0.0' || host.startsWith('127.');
  if (ipVersion === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return host === 'localhost'
    || host === 'localhost.';
}

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

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function endpointFromEnv(env = process.env) {
  return env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || DEFAULT_ENDPOINT;
}

function authStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_STATE_PATH) {
    return path.resolve(env.TRAFFIC_ONE_AUTH_STATE_PATH);
  }
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
  return path.join(base, 'auth.json');
}

function authChoiceStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) {
    return path.resolve(env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH);
  }
  return path.join(path.dirname(authStatePath(env)), 'auth-choice.json');
}

function authChoiceFallbackStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) return null;
  const digest = crypto.createHash('sha256').update(authStatePath(env)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'traffic-one', `auth-choice-${digest}.json`);
}

function authChoiceStatePaths(env = process.env) {
  const primary = authChoiceStatePath(env);
  const fallback = authChoiceFallbackStatePath(env);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

function readJson(filePath, fallback = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeAuthState(state, env = process.env) {
  const filePath = authStatePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod.
  }
  return filePath;
}

function readAuthState(env = process.env) {
  return readJson(authStatePath(env), null);
}

function deleteAuthState(env = process.env) {
  try {
    fs.rmSync(authStatePath(env), { force: true });
    return true;
  } catch {
    return false;
  }
}

function deleteAuthChoiceState(env = process.env) {
  let ok = true;
  for (const filePath of authChoiceStatePaths(env)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

function authChoiceStateExists(env = process.env) {
  return authChoiceStatePaths(env).some((filePath) => fs.existsSync(filePath));
}

const FRESHNESS_REASON = {
  OK: 'ok',
  MISSING: 'missing-auth-state',
  VERSION_MISMATCH: 'version-mismatch',
  MALFORMED_TOKEN: 'malformed-token',
  MALFORMED_EXPIRY: 'malformed-expiry',
  ENDPOINT_MISMATCH: 'endpoint-mismatch',
  EXPIRED: 'expired',
};

// Returns the precise reason a stored session is (not) usable. Endpoint mismatch
// is reported ahead of expiry because it signals a configuration problem (the
// token belongs to a different server) rather than the ordinary, recoverable
// "session timed out" case that a refresh with the same key can fix.
function authStateFreshness(state, env = process.env, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') {
    return { fresh: false, reason: FRESHNESS_REASON.MISSING };
  }
  if (state.version !== AUTH_STATE_VERSION) {
    return { fresh: false, reason: FRESHNESS_REASON.VERSION_MISMATCH };
  }
  if (typeof state.sessionToken !== 'string' || !state.sessionToken.startsWith('tok_')) {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_TOKEN };
  }
  if (typeof state.expiresAt !== 'string') {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_EXPIRY };
  }
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires)) {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_EXPIRY };
  }
  if (state.endpoint !== endpointFromEnv(env)) {
    return { fresh: false, reason: FRESHNESS_REASON.ENDPOINT_MISMATCH };
  }
  if (expires - EXPIRY_SKEW_MS <= nowMs) {
    return { fresh: false, reason: FRESHNESS_REASON.EXPIRED };
  }
  return { fresh: true, reason: FRESHNESS_REASON.OK };
}

function isAuthStateFresh(state, env = process.env, nowMs = Date.now()) {
  return authStateFreshness(state, env, nowMs).fresh;
}

function isAuthenticatedLocal(env = process.env, nowMs = Date.now()) {
  return isAuthStateFresh(readAuthState(env), env, nowMs);
}

function authRemoteCheckDue(state = readAuthState(), env = process.env, nowMs = Date.now()) {
  if (!isAuthStateFresh(state, env, nowMs)) return false;
  const lastChecked = Date.parse(state.lastRemoteCheckedAt || '');
  return !Number.isFinite(lastChecked) || nowMs - lastChecked >= REMOTE_AUTH_CHECK_INTERVAL_MS;
}

function currentSessionToken(env = process.env) {
  const state = readAuthState(env);
  return isAuthStateFresh(state, env) ? state.sessionToken : null;
}

function buildMcpPayload(toolName, args = {}) {
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

function extractToolText(responseBody) {
  const tryParse = (text) => {
    try {
      const parsed = JSON.parse(text);
      const content = parsed && parsed.result && parsed.result.content;
      if (Array.isArray(content) && content[0] && typeof content[0].text === 'string') {
        return content[0].text;
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

function isRemoteAuthRejection(error) {
  return error && (error.statusCode === 401 || error.statusCode === 403);
}

function stampRemoteCheck(state, patch, env = process.env) {
  const next = {
    ...state,
    ...patch,
    lastRemoteCheckedAt: nowIso(),
  };
  return writeAuthState(next, env);
}

function keyFromArgs(args, env = process.env) {
  const keyIndex = args.indexOf('--key');
  if (keyIndex >= 0 && args[keyIndex + 1]) return args[keyIndex + 1];
  if (args.includes('--stdin')) {
    return fs.readFileSync(0, 'utf8').trim();
  }
  return env.TRAFFIC_ONE_AUTH_KEY || '';
}

function authStateFromResult(endpoint, result) {
  return {
    version: AUTH_STATE_VERSION,
    endpoint,
    sessionToken: result.sessionToken,
    expiresAt: result.expiresAt,
    keyId: result.keyId,
    authenticatedAt: nowIso(),
    lastRemoteCheckedAt: nowIso(),
    lastRemoteCheckOkAt: nowIso(),
  };
}

function writeSessionResult(endpoint, result, env = process.env) {
  if (!result || result.authenticated !== true || typeof result.sessionToken !== 'string') {
    throw new Error('Authentication response did not include a session token');
  }
  const state = authStateFromResult(endpoint, result);
  const filePath = writeAuthState(state, env);
  deleteAuthChoiceState(env);
  return { state, filePath };
}

async function login(args = process.argv.slice(3), env = process.env) {
  const apiKey = keyFromArgs(args, env);
  if (!apiKey) {
    throw new Error('Missing API key. Set TRAFFIC_ONE_AUTH_KEY or pass --stdin.');
  }
  const endpoint = endpointFromEnv(env);
  const result = await mcpRequest(endpoint, 'authenticate', apiKey, {});
  const { state, filePath } = writeSessionResult(endpoint, result, env);
  return { ok: true, filePath, keyId: state.keyId, expiresAt: state.expiresAt };
}

async function refresh(args = process.argv.slice(3), env = process.env, options = {}) {
  const apiKey = keyFromArgs(args, env);
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const priorReason = options.priorReason || null;
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-not-possible',
      detail: 'missing-api-key',
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }

  let result;
  try {
    result = await mcpRequest(endpoint, 'refresh', apiKey, {});
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-failed',
      error: error.message,
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }

  try {
    const written = writeSessionResult(endpoint, result, env);
    return {
      ok: true,
      authenticated: true,
      reauthenticated: true,
      ...(priorReason ? { priorReason } : {}),
      filePath: written.filePath,
      keyId: written.state.keyId,
      expiresAt: written.state.expiresAt,
      endpoint,
    };
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-failed',
      error: error.message,
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }
}

async function status(args = process.argv.slice(3), env = process.env) {
  const state = readAuthState(env);
  const freshness = authStateFreshness(state, env);
  if (!freshness.fresh) {
    const localReason = freshness.reason;
    if (state) {
      return refresh(args, env, { priorReason: localReason });
    }
    return {
      ok: false,
      authenticated: false,
      reason: localReason,
      filePath: authStatePath(env),
      endpoint: endpointFromEnv(env),
    };
  }
  if (!args.includes('--remote')) {
    return {
      ok: true,
      authenticated: true,
      keyId: state.keyId,
      expiresAt: state.expiresAt,
      endpoint: state.endpoint,
      filePath: authStatePath(env),
    };
  }
  let result;
  try {
    result = await mcpRequest(state.endpoint, 'auth_status', state.sessionToken, {});
  } catch (error) {
    if (isRemoteAuthRejection(error)) {
      const refreshed = await refresh(args, env, { priorReason: 'remote-auth-rejected' });
      if (refreshed.ok) return { ...refreshed, remoteChecked: true };
      deleteAuthState(env);
      return refreshed;
    }
    stampRemoteCheck(state, {
      lastRemoteCheckError: error.message,
    }, env);
    return {
      ok: false,
      authenticated: true,
      localAuthenticated: true,
      remoteChecked: false,
      reason: 'remote-check-failed',
      error: error.message,
      keyId: state.keyId,
      expiresAt: state.expiresAt,
      endpoint: state.endpoint,
      filePath: authStatePath(env),
    };
  }
  if (result.authenticated !== true) {
    const refreshed = await refresh(args, env, { priorReason: result.reason || 'remote-auth-rejected' });
    if (refreshed.ok) return { ...refreshed, remoteChecked: true };
    deleteAuthState(env);
    return refreshed;
  }
  if (result.authenticated === true) {
    stampRemoteCheck(state, {
      keyId: result.keyId || state.keyId,
      expiresAt: result.expiresAt || state.expiresAt,
      lastRemoteCheckOkAt: nowIso(),
      lastRemoteCheckError: null,
    }, env);
  }
  return {
    ok: result.authenticated === true,
    authenticated: result.authenticated === true,
    keyId: result.keyId,
    expiresAt: result.expiresAt,
    endpoint: state.endpoint,
    filePath: authStatePath(env),
  };
}

async function logout(_args = process.argv.slice(3), env = process.env) {
  const token = currentSessionToken(env);
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  if (token) {
    try {
      await mcpRequest(endpoint, 'logout', token, {}, 5000);
    } catch {
      // Stateless server sessions; local deletion is the important part.
    }
  }
  const deleted = deleteAuthState(env);
  const authChoicePath = authChoiceStatePath(env);
  const choiceDeleted = deleteAuthChoiceState(env);
  if (!deleted && fs.existsSync(filePath)) {
    return {
      ok: false,
      authenticated: true,
      reason: 'delete-auth-state-failed',
      filePath,
    };
  }
  if (!choiceDeleted && authChoiceStateExists(env)) {
    return {
      ok: false,
      authenticated: true,
      reason: 'delete-auth-choice-state-failed',
      filePath,
      authChoicePath,
    };
  }
  return { ok: true, authenticated: false, filePath, authChoicePath };
}

function authRequiredMessage(env = process.env) {
  const endpoint = endpointFromEnv(env);
  return [
    'Traffic One authentication is required before this plugin can be used.',
    '',
    'Ask the user with a modal selector before continuing:',
    '  - Authenticate Traffic One (Recommended)',
    '  - Continue without Traffic One',
    '',
    'If the user chooses Authenticate Traffic One, ask for the API key and run authentication internally with TRAFFIC_ONE_AUTH_KEY, then verify status internally.',
    'Internally means: invoke scripts/traffic-one-auth.cjs login (and then status) via your own shell tool with TRAFFIC_ONE_AUTH_KEY=<key> in env. The pre-tool gate explicitly allows these scripts/traffic-one-auth.cjs (login|refresh|status|logout) shell invocations even while unauthenticated, so they will not be denied. Do not try to Write or Edit auth.json directly; only the script can produce a valid session token.',
    'If a stored session expires and TRAFFIC_ONE_AUTH_KEY is still available, the auth client will try `refresh` before requiring a new key.',
    'Do not ask the user to run bash or shell commands for Traffic One authentication.',
    'If the user chooses Continue without Traffic One, remember that choice for the current project while it remains active and continue without Traffic One features.',
    `Endpoint: ${endpoint}`,
    `Auth state: ${authStatePath(env)}`,
  ].join('\n');
}

function isTrafficOneAuthCommand(command) {
  return /\bscripts\/traffic-one-auth\.cjs\b/.test(String(command || ''))
    && /\b(login|refresh|status|logout)\b/.test(String(command || ''));
}

function isTrafficOneDoctorCommand(command) {
  return /\bscripts\/doctor\.cjs\b/.test(String(command || ''));
}

async function main() {
  const command = process.argv[2] || 'status';
  let result;
  if (command === 'login') {
    result = await login();
  } else if (command === 'refresh') {
    result = await refresh();
  } else if (command === 'status') {
    result = await status();
  } else if (command === 'logout') {
    result = await logout();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && result.authenticated === false && command === 'status') {
    process.exitCode = 1;
  }
  if (result && result.ok === false) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  AUTH_STATE_VERSION,
  DEFAULT_ENDPOINT,
  FRESHNESS_REASON,
  REMOTE_AUTH_CHECK_INTERVAL_MS,
  authEndpointUrl,
  authStateFreshness,
  authChoiceStatePath,
  authChoiceStatePaths,
  authRemoteCheckDue,
  authRequiredMessage,
  authStatePath,
  buildMcpPayload,
  currentSessionToken,
  deleteAuthChoiceState,
  deleteAuthState,
  endpointFromEnv,
  isAuthenticatedLocal,
  isAuthStateFresh,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  login,
  refresh,
  logout,
  mcpRequest,
  readAuthState,
  status,
  writeAuthState,
};
