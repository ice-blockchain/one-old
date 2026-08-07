// src/runners/one-mcp-report/lib.ts
// Low-level helpers for the one-mcp first-look report: constants, file-walk +
// skip rules, dependency scan, technology/component mapping, infra-vendor
// detection, and project-state IO. Ported 1:1 from one-mcp-report/_helpers.cjs
// (the network client + report-id mint live with the orchestration half). The
// legacy "hoisted forwarder" circular-dep workaround is removed: this module
// has no dependency on the collectors or the report-id reader.

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

import {
  ONE_MCP_REPORTED_FILE_EXTENSIONS,
  ONE_MCP_REPORT_TIMEOUT_MS,
  SKIP_DIRS,
  SKIP_FILES,
} from '../../config/reporting';
import { LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { readJsonResult } from '../../shared/fsjson';
import { stripLocalPreferenceFields } from '../../shared/state/local-prefs';
import {
  preserveCurrentRunId,
  preserveOneMcpReportId,
  withProjectStateLock,
} from '../../shared/state/project-state-lock';
import {
  postOneMcpJsonRpc,
  type OneMcpJsonRpcRequest,
  type OneMcpRequestFactory,
} from '../../shared/one-mcp';
import { buildMcpPayload } from './buildMcpPayload';

type Rec = Record<string, unknown>;

export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(filePath: string, fallback: unknown = null): unknown {
  const text = readText(filePath);
  if (text === null) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * RAW writer — `fs` directly, deliberately outside `shared/fsjson.ts`, so none
 * of that chokepoint's guarantees apply: no consent fence, no symlink refusal,
 * no containment check against the resolved project root.
 *
 * That matters more than it looks, because `writeProjectState` below publishes
 * the CANONICAL COMMITTED `.one.json` through it. What keeps that safe today is
 * not this function: `prepareReport` asks `pluginUseEnabled(root)` before it
 * reaches `createReportId`, one frame up, and `createReportId` is the only
 * non-test caller of `writeProjectState`. So the consent guarantee is the
 * CALLER'S, and a second caller added here would inherit none of it.
 *
 * Containment is genuinely uncovered rather than covered elsewhere: a planted
 * directory symlink at `.traffic-one` would let the rename land outside the
 * project. A final-component link is harmless (rename replaces the link itself),
 * and an actor able to plant either could write the file directly anyway, so
 * what is lost is defence in depth rather than a new capability.
 */
export function writeJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(filePath).mode & 0o777; } catch { /* new file */ }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
    // The file is durable before rename; persist the directory entry when the
    // platform supports directory fsync as well.
    let dirFd: number | null = null;
    try {
      dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      // Some filesystems reject directory fsync. Atomic rename still applies.
    } finally {
      if (dirFd !== null) try { fs.closeSync(dirFd); } catch { /* best-effort */ }
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
  }
}

export function statePath(cwd: string): string {
  return path.join(cwd, STATE_FILE);
}
export function legacyStatePath(cwd: string): string {
  return path.join(cwd, LEGACY_STATE_FILE);
}

export function readProjectState(cwd: string): Rec {
  const nextState = readJson(statePath(cwd), null);
  if (nextState && typeof nextState === 'object') return nextState as Rec;
  const legacyState = readJson(legacyStatePath(cwd), null);
  return legacyState && typeof legacyState === 'object' ? (legacyState as Rec) : {};
}

/**
 * Persist the shared project state through the RAW writer, and report whether
 * `.one.json` now holds it.
 *
 * NOT the stripping writeState. It runs during onboarding to mint one-uid, so
 * without stripping it re-persists machine-local preference fields (team / toolchain with an
 * absolute binPath / performance / …) into the COMMITTED .one.json — the Codex
 * onboarding-complete leak, where this write lands while the effective state is still merged.
 * Those fields live in the per-user preferences.json; strip them from project state on write.
 *
 * ── An illegible base REFUSES, and does not quarantine-then-heal ─────────────
 * `readJson(filePath, {})` used to stand in for the current file here, which
 * made a corrupt `.one.json` indistinguishable from an absent one — and the
 * consequence was total, not partial. `current` is what preserveCurrentRunId and
 * preserveOneMcpReportId read, so the two rescues that exist to stop exactly
 * this both saw `{}` and preserved nothing, while the caller's base (report-id-
 * mint.ts, through readProjectState) had ALREADY collapsed to `{}` from a second
 * illegible read of the same file. Measured on an 18-key post-onboarding state:
 * 868 bytes in, 46 bytes out — stack, mode, frontend/backend, the onboarding
 * answers, the live currentRunId and the durable one-uid all replaced by a
 * freshly minted id. A chmod-000 file gave the identical 46 bytes, silently,
 * and kept mode 000 so the wreckage could not even be read back.
 *
 * state/normalize.ts writeState answers `corrupt` by preserving the bytes beside
 * the file and proceeding, and that ruling does NOT transfer here — it is
 * conditioned on something this function does not have. Quarantining is only
 * worth its cost to a caller that meant to REPLACE the whole file and therefore
 * has something to put there. This function's sole caller is a one-field patch
 * (`state[ONE_UID_FIELD] = id` over a base it believed it read), so proceeding
 * would publish a file asserting the project is un-onboarded; because that file
 * PARSES, the canonical healer would never see a corrupt `.one.json` again and
 * the project would look freshly reset rather than broken. Refusing leaves the
 * bytes untouched under their own name and leaves the heal to writeState, which
 * quarantines the same bytes AND publishes a complete state. That is patchState's
 * ruling ("a base we cannot see leaves nothing honest to publish"), which is the
 * precedent this caller's shape actually matches.
 *
 * `unreadable` therefore gets the SAME answer as `corrupt` here rather than the
 * opposite one, because the argument that separates them upstream — that
 * `corrupt` can be copied aside and `unreadable` cannot — only decides whether
 * quarantine is possible, and nothing is being quarantined either way.
 */
export function writeProjectState(cwd: string, state: unknown): boolean {
  const filePath = statePath(cwd);
  const replacement = stripLocalPreferenceFields(state && typeof state === 'object' ? state : {});
  let persisted = false;
  withProjectStateLock(cwd, () => {
    const read = readJsonResult<Rec>(filePath);
    if (read.kind === 'corrupt' || read.kind === 'unreadable') return;
    const current = read.kind === 'ok' ? read.value : {};
    writeJson(filePath, preserveCurrentRunId(current, preserveOneMcpReportId(current, replacement)));
    persisted = true;
  });
  return persisted;
}

function shouldSkipFile(relPath: string, fileName: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (SKIP_FILES.has(fileName)) return true;
  if (/\.(min|bundle)\.(js|css)$/i.test(fileName)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(fileName)) return true;
  if (/\.g\.dart$/i.test(fileName) || /\.pb\.(go|ts|js)$/i.test(fileName)) return true;
  if (/(^|\/)(__tests__|tests?|fixtures?|vendor)(\/|$)/i.test(normalized)) return true;
  return false;
}

export function walkFiles(cwd: string, visitor: (absPath: string, relPath: string) => void, relDir = ''): void {
  const dir = path.join(cwd, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(cwd, visitor, path.join(relDir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const relPath = path.join(relDir, entry.name);
    if (shouldSkipFile(relPath, entry.name)) continue;
    visitor(path.join(cwd, relPath), relPath);
  }
}

export function extensionFor(filePath: string): string | null {
  const base = path.basename(filePath);
  if (base === 'Dockerfile') return 'dockerfile';
  const ext = path.extname(base).replace(/^\./, '').toLowerCase();
  return ext && ONE_MCP_REPORTED_FILE_EXTENSIONS.has(ext) ? ext : null;
}

export function countLines(text: string | null): number {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function packageJsonFiles(cwd: string): string[] {
  const files: string[] = [];
  walkFiles(cwd, (absPath, relPath) => {
    if (path.basename(relPath) === 'package.json') files.push(absPath);
  });
  files.sort();
  return files;
}

export function dependencyNames(cwd: string): Set<string> {
  const names = new Set<string>();
  for (const filePath of packageJsonFiles(cwd)) {
    const pkg = readJson(filePath, {}) as Rec;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg && pkg[section] && typeof pkg[section] === 'object' ? (pkg[section] as Rec) : {};
      for (const name of Object.keys(deps)) names.add(name);
    }
    if (typeof pkg.packageManager === 'string') {
      const manager = pkg.packageManager.split('@')[0]!.toLowerCase();
      if (manager) names.add(`package-manager:${manager}`);
    }
  }
  return names;
}

export function addTechForDependency(techs: Set<string>, dep: string): void {
  const map = new Map<string, string>([
    ['@nestjs/core', 'nestjs'], ['@reduxjs/toolkit', 'redux'], ['@supabase/ssr', 'supabase'],
    ['@supabase/supabase-js', 'supabase'], ['@tanstack/react-query', 'tanstack-query'], ['next', 'next.js'],
    ['posthog-js', 'posthog'], ['prisma', 'prisma'], ['react', 'react'], ['react-native', 'react-native'],
    ['tailwindcss', 'tailwindcss'], ['turbo', 'turborepo'], ['typescript', 'typescript'], ['vite', 'vite'],
    ['zustand', 'zustand'],
  ]);
  if (map.has(dep)) techs.add(map.get(dep) as string);
  if (dep === 'package-manager:pnpm') techs.add('pnpm');
  if (dep === 'package-manager:npm') techs.add('npm');
  if (dep === 'package-manager:yarn') techs.add('yarn');
}

export interface ArchComponent { type: string; name: string; uses?: string[] }
export function addComponent(components: ArchComponent[], seen: Set<string>, type: string, name: string, uses: string[] = []): void {
  const key = `${type}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (type === 'custom_service') components.push({ type, name, uses });
  else components.push({ type, name });
}

export function detectInfrastructureVendor(cwd: string): string {
  const checks: [string, string][] = [
    ['vercel.json', 'vercel'], ['netlify.toml', 'netlify'], ['wrangler.toml', 'cloudflare'],
    ['fly.toml', 'fly'], ['render.yaml', 'render'], ['railway.json', 'railway'],
  ];
  for (const [fileName, vendor] of checks) {
    if (fs.existsSync(path.join(cwd, fileName))) return vendor;
  }
  return 'unknown';
}

export function parseTimestamp(value: unknown): number {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

// Compact, millisecond-stripped persisted timestamp.
export { nowIsoNoMs as nowIso } from '../../shared/text';

export function stateForReport(root: string, options: { state?: unknown } = {}): Rec {
  return options.state && typeof options.state === 'object' ? (options.state as Rec) : readProjectState(root);
}

// Fire-and-forget MCP tools/call POST. Resolves the response body on 2xx and
// rejects on a non-2xx response, MCP error, or timeout.
export async function mcpRequest(
  endpoint: string,
  payload: unknown,
  timeoutMs = ONE_MCP_REPORT_TIMEOUT_MS,
  requestImpl?: typeof https.request,
): Promise<string> {
  const request: OneMcpJsonRpcRequest = buildMcpPayload(payload);
  const response = await postOneMcpJsonRpc(endpoint, request, {
    timeoutMs,
    ...(requestImpl ? { requestFactory: requestImpl as OneMcpRequestFactory } : {}),
  });
  const result = response.result && typeof response.result === 'object'
    ? response.result as Rec
    : null;
  if (response.error !== undefined || result?.isError === true) {
    throw new Error('MCP error response');
  }
  return JSON.stringify(response);
}
