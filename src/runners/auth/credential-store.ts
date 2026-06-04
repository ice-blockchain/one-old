// src/runners/auth/credential-store.ts
// OS credential-manager bridge for the Traffic One API key. The raw key is
// NEVER persisted in auth state — only a `credentialRef` (store kind + service
// + account) is. The secret lives in the macOS Keychain, libsecret, or (for
// tests / opt-in) a 0o600 file store. Ported 1:1 from
// scripts/traffic-one-auth/credentialStore.cjs.

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CREDENTIAL_REF_VERSION, SERVICE } from '../../config/auth';

type Rec = Record<string, unknown>;

export interface CredentialRef {
  version: number;
  store: string;
  service: string;
  account: string;
  endpointHash: string;
  keyId: string | null;
}

export interface CredentialResult {
  ok: boolean;
  stored?: boolean;
  deleted?: boolean;
  reused?: boolean;
  secret?: string;
  reason?: string;
  error?: string;
  status?: number | null;
  store?: string;
}

export function endpointHash(endpoint: unknown): string {
  return crypto.createHash('sha256').update(String(endpoint || '')).digest('hex').slice(0, 16);
}

function normalizeKeyId(keyId: unknown): string {
  const normalized = String(keyId || 'default').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 80);
  return normalized || 'default';
}

export function credentialAccount(endpoint: unknown, keyId: unknown): string {
  return `traffic-one:${endpointHash(endpoint)}:${normalizeKeyId(keyId)}`;
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 1000,
  });
  return !result.error || (result.error as NodeJS.ErrnoException).code !== 'ENOENT';
}

export function credentialStoreKind(env: NodeJS.ProcessEnv = process.env): string {
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

export function credentialRefFor(endpoint: unknown, keyId: unknown, env: NodeJS.ProcessEnv = process.env): CredentialRef | null {
  const store = credentialStoreKind(env);
  if (store === 'none' || store === 'off' || store === 'disabled') return null;
  return {
    version: CREDENTIAL_REF_VERSION,
    store,
    service: SERVICE,
    account: credentialAccount(endpoint, keyId),
    endpointHash: endpointHash(endpoint),
    keyId: (keyId as string) || null,
  };
}

interface RunOk { ok: true; stdout: string; }
interface RunErr { ok: false; reason: string; error: string; status: number | null; }

function run(command: string, args: string[], options: { input?: string } = {}): RunOk | RunErr {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
    ...options,
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout || '' };
  return {
    ok: false,
    reason: result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'credential-helper-missing' : 'credential-helper-failed',
    error: (result.stderr || (result.error && result.error.message) || '').trim(),
    status: typeof result.status === 'number' ? result.status : null,
  };
}

function fileStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH || path.join(os.tmpdir(), 'traffic-one-auth-credentials.json'));
}

function readFileStore(env: NodeJS.ProcessEnv = process.env): Rec {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileStorePath(env), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Rec : {};
  } catch {
    return {};
  }
}

function writeFileStore(data: Rec, env: NodeJS.ProcessEnv = process.env): void {
  const filePath = fileStorePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

function storeFileCredential(ref: CredentialRef, secret: string, env: NodeJS.ProcessEnv = process.env): CredentialResult {
  const data = readFileStore(env);
  data[ref.account] = {
    service: ref.service,
    secret,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileStore(data, env);
  return { ok: true, stored: true, store: ref.store };
}

function readFileCredential(ref: CredentialRef, env: NodeJS.ProcessEnv = process.env): CredentialResult {
  const data = readFileStore(env);
  const record = data[ref.account] as Rec | undefined;
  if (!record || typeof record.secret !== 'string') {
    return { ok: false, reason: 'credential-not-found', store: ref.store };
  }
  return { ok: true, secret: record.secret, store: ref.store };
}

function deleteFileCredential(ref: CredentialRef, env: NodeJS.ProcessEnv = process.env): CredentialResult {
  const data = readFileStore(env);
  const existed = Object.prototype.hasOwnProperty.call(data, ref.account);
  delete data[ref.account];
  writeFileStore(data, env);
  return { ok: true, deleted: existed, store: ref.store };
}

function storeMacosCredential(ref: CredentialRef, secret: string): CredentialResult {
  const result = run('/usr/bin/security', ['add-generic-password', '-U', '-s', ref.service, '-a', ref.account, '-w', secret]);
  return result.ok ? { ok: true, stored: true, store: ref.store } : { ...result, store: ref.store };
}

function readMacosCredential(ref: CredentialRef): CredentialResult {
  const result = run('/usr/bin/security', ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w']);
  if (!result.ok) return { ...result, reason: result.reason || 'credential-not-found', store: ref.store };
  const secret = String(result.stdout || '').replace(/\r?\n$/, '');
  if (!secret) return { ok: false, reason: 'credential-empty', store: ref.store };
  return { ok: true, secret, store: ref.store };
}

function deleteMacosCredential(ref: CredentialRef): CredentialResult {
  const result = run('/usr/bin/security', ['delete-generic-password', '-s', ref.service, '-a', ref.account]);
  if (result.ok) return { ok: true, deleted: true, store: ref.store };
  return { ok: true, deleted: false, store: ref.store, reason: 'credential-not-found' };
}

function storeLibsecretCredential(ref: CredentialRef, secret: string): CredentialResult {
  const result = run('secret-tool', ['store', '--label', 'Traffic One API key', 'service', ref.service, 'account', ref.account], { input: secret });
  return result.ok ? { ok: true, stored: true, store: ref.store } : { ...result, store: ref.store };
}

function readLibsecretCredential(ref: CredentialRef): CredentialResult {
  const result = run('secret-tool', ['lookup', 'service', ref.service, 'account', ref.account]);
  if (!result.ok) return { ...result, reason: result.reason || 'credential-not-found', store: ref.store };
  const secret = String(result.stdout || '').replace(/\r?\n$/, '');
  if (!secret) return { ok: false, reason: 'credential-empty', store: ref.store };
  return { ok: true, secret, store: ref.store };
}

function deleteLibsecretCredential(ref: CredentialRef): CredentialResult {
  const result = run('secret-tool', ['clear', 'service', ref.service, 'account', ref.account]);
  if (result.ok) return { ok: true, deleted: true, store: ref.store };
  return { ok: true, deleted: false, store: ref.store, reason: 'credential-not-found' };
}

export function storeCredential(ref: CredentialRef | null, secret: string, env: NodeJS.ProcessEnv = process.env): CredentialResult {
  if (!ref || !secret) return { ok: false, stored: false, reason: 'missing-credential-input' };
  if (ref.store === 'file') return storeFileCredential(ref, secret, env);
  if (ref.store === 'macos-keychain') return storeMacosCredential(ref, secret);
  if (ref.store === 'libsecret') return storeLibsecretCredential(ref, secret);
  return { ok: false, stored: false, reason: 'credential-store-unavailable', store: ref.store || 'none' };
}

export function readCredential(ref: CredentialRef | null, env: NodeJS.ProcessEnv = process.env): CredentialResult {
  if (!ref) return { ok: false, reason: 'missing-credential-ref' };
  if (ref.store === 'file') return readFileCredential(ref, env);
  if (ref.store === 'macos-keychain') return readMacosCredential(ref);
  if (ref.store === 'libsecret') return readLibsecretCredential(ref);
  return { ok: false, reason: 'credential-store-unavailable', store: ref.store || 'none' };
}

export function deleteCredential(ref: CredentialRef | null, env: NodeJS.ProcessEnv = process.env): CredentialResult {
  if (!ref) return { ok: true, deleted: false, reason: 'missing-credential-ref' };
  if (ref.store === 'file') return deleteFileCredential(ref, env);
  if (ref.store === 'macos-keychain') return deleteMacosCredential(ref);
  if (ref.store === 'libsecret') return deleteLibsecretCredential(ref);
  return { ok: true, deleted: false, reason: 'credential-store-unavailable', store: ref.store || 'none' };
}
