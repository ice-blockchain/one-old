'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

// Exported functions that these private helpers call live in sibling files
// that, in turn, require this module. Resolving them lazily through hoisted
// forwarders keeps each function body byte-for-byte identical while avoiding a
// CommonJS cycle that would otherwise capture a partial export at load time.
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}
function authChoiceStatePaths(...args) {
  return require('./authChoiceStatePaths.cjs').authChoiceStatePaths(...args);
}
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}
function writeAuthState(...args) {
  return require('./writeAuthState.cjs').writeAuthState(...args);
}
function deleteAuthChoiceState(...args) {
  return require('./deleteAuthChoiceState.cjs').deleteAuthChoiceState(...args);
}

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

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function authChoiceFallbackStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) return null;
  const digest = crypto.createHash('sha256').update(authStatePath(env)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'traffic-one', `auth-choice-${digest}.json`);
}

function readJson(filePath, fallback = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
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

function isRemoteAuthRejection(error) {
  return error && (error.statusCode === 401 || error.statusCode === 403);
}

// Node throws an AggregateError with an empty `.message` when a dual-stack
// `localhost` connection is refused on both ::1 and 127.0.0.1. Surface a useful
// string in that case so a failure is never opaque.
function errorMessage(error) {
  if (!error) return '';
  if (error.message) return error.message;
  if (Array.isArray(error.errors) && error.errors.length) {
    return error.errors.map((sub) => (sub && sub.message) || String(sub)).join('; ');
  }
  if (error.code) return String(error.code);
  return String(error);
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

module.exports = {
  DEFAULT_ENDPOINT,
  AUTH_STATE_VERSION,
  EXPIRY_SKEW_MS,
  REMOTE_AUTH_CHECK_INTERVAL_MS,
  FRESHNESS_REASON,
  isLoopbackHostname,
  nowIso,
  authChoiceFallbackStatePath,
  readJson,
  authChoiceStateExists,
  extractToolText,
  isRemoteAuthRejection,
  errorMessage,
  stampRemoteCheck,
  keyFromArgs,
  authStateFromResult,
  writeSessionResult,
};
