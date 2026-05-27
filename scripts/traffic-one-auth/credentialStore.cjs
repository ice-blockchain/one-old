'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CREDENTIAL_REF_VERSION = 1;
const SERVICE = 'traffic-one';

function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint || '')).digest('hex').slice(0, 16);
}

function normalizeKeyId(keyId) {
  const normalized = String(keyId || 'default').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 80);
  return normalized || 'default';
}

function credentialAccount(endpoint, keyId) {
  return `traffic-one:${endpointHash(endpoint)}:${normalizeKeyId(keyId)}`;
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 1000,
  });
  return !result.error || result.error.code !== 'ENOENT';
}

function credentialStoreKind(env = process.env) {
  const explicit = String(env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE || '').trim().toLowerCase();
  if (explicit === 'keychain' || explicit === 'credential-manager' || explicit === 'os') {
    if (process.platform === 'darwin') return 'macos-keychain';
    if (process.platform === 'linux' && commandExists('secret-tool')) return 'libsecret';
    return 'none';
  }
  if (explicit) return explicit;
  if (env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH) return 'file';
  if (process.platform === 'darwin') return 'macos-keychain';
  if (process.platform === 'linux' && commandExists('secret-tool')) return 'libsecret';
  return 'none';
}

function credentialRefFor(endpoint, keyId, env = process.env) {
  const store = credentialStoreKind(env);
  if (store === 'none' || store === 'off' || store === 'disabled') return null;
  return {
    version: CREDENTIAL_REF_VERSION,
    store,
    service: SERVICE,
    account: credentialAccount(endpoint, keyId),
    endpointHash: endpointHash(endpoint),
    keyId: keyId || null,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
    ...options,
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout || '' };
  return {
    ok: false,
    reason: result.error && result.error.code === 'ENOENT' ? 'credential-helper-missing' : 'credential-helper-failed',
    error: (result.stderr || (result.error && result.error.message) || '').trim(),
    status: result.status,
  };
}

function fileStorePath(env = process.env) {
  return path.resolve(env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH || path.join(os.tmpdir(), 'traffic-one-auth-credentials.json'));
}

function readFileStore(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileStorePath(env), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeFileStore(data, env = process.env) {
  const filePath = fileStorePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

function storeFileCredential(ref, secret, env = process.env) {
  const data = readFileStore(env);
  data[ref.account] = {
    service: ref.service,
    secret,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileStore(data, env);
  return { ok: true, stored: true, store: ref.store };
}

function readFileCredential(ref, env = process.env) {
  const data = readFileStore(env);
  const record = data[ref.account];
  if (!record || typeof record.secret !== 'string') {
    return { ok: false, reason: 'credential-not-found', store: ref.store };
  }
  return { ok: true, secret: record.secret, store: ref.store };
}

function deleteFileCredential(ref, env = process.env) {
  const data = readFileStore(env);
  const existed = Object.prototype.hasOwnProperty.call(data, ref.account);
  delete data[ref.account];
  writeFileStore(data, env);
  return { ok: true, deleted: existed, store: ref.store };
}

function storeMacosCredential(ref, secret) {
  const result = run('/usr/bin/security', [
    'add-generic-password',
    '-U',
    '-s', ref.service,
    '-a', ref.account,
    '-w', secret,
  ]);
  return result.ok ? { ok: true, stored: true, store: ref.store } : { ...result, store: ref.store };
}

function readMacosCredential(ref) {
  const result = run('/usr/bin/security', [
    'find-generic-password',
    '-s', ref.service,
    '-a', ref.account,
    '-w',
  ]);
  if (!result.ok) return { ...result, reason: result.reason || 'credential-not-found', store: ref.store };
  const secret = String(result.stdout || '').replace(/\r?\n$/, '');
  if (!secret) return { ok: false, reason: 'credential-empty', store: ref.store };
  return { ok: true, secret, store: ref.store };
}

function deleteMacosCredential(ref) {
  const result = run('/usr/bin/security', [
    'delete-generic-password',
    '-s', ref.service,
    '-a', ref.account,
  ]);
  if (result.ok) return { ok: true, deleted: true, store: ref.store };
  return { ok: true, deleted: false, store: ref.store, reason: 'credential-not-found' };
}

function storeLibsecretCredential(ref, secret) {
  const result = run('secret-tool', [
    'store',
    '--label', 'Traffic One API key',
    'service', ref.service,
    'account', ref.account,
  ], { input: secret });
  return result.ok ? { ok: true, stored: true, store: ref.store } : { ...result, store: ref.store };
}

function readLibsecretCredential(ref) {
  const result = run('secret-tool', [
    'lookup',
    'service', ref.service,
    'account', ref.account,
  ]);
  if (!result.ok) return { ...result, reason: result.reason || 'credential-not-found', store: ref.store };
  const secret = String(result.stdout || '').replace(/\r?\n$/, '');
  if (!secret) return { ok: false, reason: 'credential-empty', store: ref.store };
  return { ok: true, secret, store: ref.store };
}

function deleteLibsecretCredential(ref) {
  const result = run('secret-tool', [
    'clear',
    'service', ref.service,
    'account', ref.account,
  ]);
  if (result.ok) return { ok: true, deleted: true, store: ref.store };
  return { ok: true, deleted: false, store: ref.store, reason: 'credential-not-found' };
}

function storeCredential(ref, secret, env = process.env) {
  if (!ref || !secret) return { ok: false, stored: false, reason: 'missing-credential-input' };
  if (ref.store === 'file') return storeFileCredential(ref, secret, env);
  if (ref.store === 'macos-keychain') return storeMacosCredential(ref, secret);
  if (ref.store === 'libsecret') return storeLibsecretCredential(ref, secret);
  return { ok: false, stored: false, reason: 'credential-store-unavailable', store: ref.store || 'none' };
}

function readCredential(ref, env = process.env) {
  if (!ref) return { ok: false, reason: 'missing-credential-ref' };
  if (ref.store === 'file') return readFileCredential(ref, env);
  if (ref.store === 'macos-keychain') return readMacosCredential(ref);
  if (ref.store === 'libsecret') return readLibsecretCredential(ref);
  return { ok: false, reason: 'credential-store-unavailable', store: ref.store || 'none' };
}

function deleteCredential(ref, env = process.env) {
  if (!ref) return { ok: true, deleted: false, reason: 'missing-credential-ref' };
  if (ref.store === 'file') return deleteFileCredential(ref, env);
  if (ref.store === 'macos-keychain') return deleteMacosCredential(ref);
  if (ref.store === 'libsecret') return deleteLibsecretCredential(ref);
  return { ok: true, deleted: false, reason: 'credential-store-unavailable', store: ref.store || 'none' };
}

module.exports = {
  CREDENTIAL_REF_VERSION,
  SERVICE,
  credentialAccount,
  credentialRefFor,
  credentialStoreKind,
  deleteCredential,
  endpointHash,
  readCredential,
  storeCredential,
};
