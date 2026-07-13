// src/shared/onboarding-server/registry.ts
// Per-project runtime record for the local onboarding wizard server. Lives next
// to the per-user project preferences (~/.traffic-one/projects/<hash>/...), so it
// honors TRAFFIC_ONE_PROJECT_PREFS_PATH in tests and is never committed. The
// detached server writes {pid,port,token,url} AFTER it starts listening; the gate's
// ensureOnboardingServer reads it back to decide reuse-vs-relaunch. A separate
// completion sentinel lets the next hook print a positive "setup complete" signal
// without re-deriving the full predicate chain.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../fsjson';
import { detectHost } from '../host';
import { canonicalHost } from '../model-tiers';
import { obj } from '../obj';
import { stateTimestamp } from '../state/io';
import { projectPrefsPath } from '../state/local-prefs';
import { HOST_IDS, type HostModelKey } from '../../config/model-tiers';

export interface ServerRecord {
  pid: number;
  port: number;
  token: string;
  url: string;
  startedAt: string;
  host?: HostModelKey;
}

function runtimeDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.dirname(projectPrefsPath(cwd, env));
}

function runtimeHost(env: NodeJS.ProcessEnv, host?: unknown): HostModelKey {
  return canonicalHost(host ?? detectHost(env));
}

function hostRuntimeDir(cwd: string, env: NodeJS.ProcessEnv, host?: unknown): string {
  return path.join(runtimeDir(cwd, env), 'onboarding', runtimeHost(env, host));
}

export function serverRecordPath(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): string {
  return path.join(hostRuntimeDir(cwd, env, host), 'server.json');
}

export function completionSentinelPath(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): string {
  return path.join(hostRuntimeDir(cwd, env, host), 'complete.json');
}

// Single-launcher lock: ensureOnboardingServer creates this O_EXCL before spawning,
// so concurrent hook PROCESSES (each Cursor hook is its own `node` process) can't
// each spawn a server on a different ephemeral port — the port-churn that handed the
// agent a URL pointing at an orphaned/dead instance.
export function serverLockPath(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): string {
  return path.join(hostRuntimeDir(cwd, env, host), 'server.lock');
}

const LEGACY_RUNTIME_BASENAMES = [
  'onboarding-server.json',
  'onboarding-complete.json',
  'onboarding-server.lock',
] as const;

// The pre-host-scoping files are ambiguous and therefore never reused. Remove
// them best-effort on the first new-format write/launch so stale tokens and
// locks do not linger indefinitely.
export function clearLegacyOnboardingRuntime(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = runtimeDir(cwd, env);
  for (const basename of LEGACY_RUNTIME_BASENAMES) {
    try { fs.rmSync(path.join(dir, basename), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// 0700 dir + 0600 file, matching the auth-choice state writer — the token grants
// access to the wizard, so keep it readable only by the owning user. Written
// atomically (temp + rename) so a concurrent reader never sees a half-written or
// last-writer-torn record (the onboarding-server port-churn race).
function writeSecureJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod
  }
  fs.renameSync(tmp, filePath); // atomic on the same filesystem
}

export function readServerRecord(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): ServerRecord | null {
  const activeHost = runtimeHost(env, host);
  const raw = obj(readJson(serverRecordPath(cwd, env, activeHost), null));
  if (!raw) return null;
  const pid = Number(raw.pid);
  const port = Number(raw.port);
  const token = typeof raw.token === 'string' ? raw.token : '';
  const url = typeof raw.url === 'string' ? raw.url : '';
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : '';
  const recordedHost = typeof raw.host === 'string' && (HOST_IDS as readonly string[]).includes(raw.host)
    ? raw.host as HostModelKey
    : null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!token || !url) return null;
  if (recordedHost !== activeHost) return null;
  return { pid, port, token, url, startedAt, host: activeHost };
}

export function writeServerRecord(cwd: string, record: ServerRecord, env: NodeJS.ProcessEnv = process.env, host?: unknown): void {
  const activeHost = runtimeHost(env, host ?? record.host);
  clearLegacyOnboardingRuntime(cwd, env);
  writeSecureJson(serverRecordPath(cwd, env, activeHost), { ...record, host: activeHost });
}

export function clearServerRecord(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): void {
  try {
    fs.unlinkSync(serverRecordPath(cwd, env, host));
  } catch {
    // already gone
  }
  clearLegacyOnboardingRuntime(cwd, env);
}

export function serverRecordExists(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): boolean {
  return readServerRecord(cwd, env, host) != null;
}

export function writeCompletionSentinel(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): void {
  const activeHost = runtimeHost(env, host);
  clearLegacyOnboardingRuntime(cwd, env);
  writeSecureJson(completionSentinelPath(cwd, env, activeHost), { host: activeHost, completedAt: stateTimestamp() });
}

export function clearCompletionSentinel(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): void {
  try {
    fs.unlinkSync(completionSentinelPath(cwd, env, host));
  } catch {
    // already gone
  }
  clearLegacyOnboardingRuntime(cwd, env);
}

export function completionSentinelExists(cwd: string, env: NodeJS.ProcessEnv = process.env, host?: unknown): boolean {
  const activeHost = runtimeHost(env, host);
  const raw = obj(readJson(completionSentinelPath(cwd, env, activeHost), null));
  return raw?.host === activeHost && typeof raw.completedAt === 'string';
}
