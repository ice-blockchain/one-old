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
import { obj } from '../obj';
import { stateTimestamp } from '../state/io';
import { projectPrefsPath } from '../state/local-prefs';

export interface ServerRecord {
  pid: number;
  port: number;
  token: string;
  url: string;
  startedAt: string;
}

function runtimeDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.dirname(projectPrefsPath(cwd, env));
}

export function serverRecordPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(cwd, env), 'onboarding-server.json');
}

export function completionSentinelPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(cwd, env), 'onboarding-complete.json');
}

// Single-launcher lock: ensureOnboardingServer creates this O_EXCL before spawning,
// so concurrent hook PROCESSES (each Cursor hook is its own `node` process) can't
// each spawn a server on a different ephemeral port — the port-churn that handed the
// agent a URL pointing at an orphaned/dead instance.
export function serverLockPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(cwd, env), 'onboarding-server.lock');
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

export function readServerRecord(cwd: string, env: NodeJS.ProcessEnv = process.env): ServerRecord | null {
  const raw = obj(readJson(serverRecordPath(cwd, env), null));
  if (!raw) return null;
  const pid = Number(raw.pid);
  const port = Number(raw.port);
  const token = typeof raw.token === 'string' ? raw.token : '';
  const url = typeof raw.url === 'string' ? raw.url : '';
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : '';
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!token || !url) return null;
  return { pid, port, token, url, startedAt };
}

export function writeServerRecord(cwd: string, record: ServerRecord, env: NodeJS.ProcessEnv = process.env): void {
  writeSecureJson(serverRecordPath(cwd, env), record);
}

export function clearServerRecord(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(serverRecordPath(cwd, env));
  } catch {
    // already gone
  }
}

export function serverRecordExists(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readServerRecord(cwd, env) != null;
}

export function writeCompletionSentinel(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  writeSecureJson(completionSentinelPath(cwd, env), { completedAt: stateTimestamp() });
}

export function clearCompletionSentinel(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(completionSentinelPath(cwd, env));
  } catch {
    // already gone
  }
}

export function completionSentinelExists(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(completionSentinelPath(cwd, env));
}
