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
import { readJsonResult, readText, writeJsonDurable } from '../../shared/fsjson';
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

/**
 * fsjson.ts's `readText`, RE-EXPORTED rather than reimplemented — this module's
 * own copy is deleted, and the copy is the point.
 *
 * It was the same bare `readFileSync`-in-a-try, with the same `string | null`
 * fold, that fsjson.ts carried until bounded-read.ts replaced it: unbounded on
 * a FIFO (`open(2)` waits for a writer forever) and on a symlink to a character
 * device. Its consumer is `collectFileExtensions`, which reads and counts lines
 * for EVERY file the report walk finds anywhere in the project, so one planted
 * shape in the tree was a `traffic-one` command that never returned. That is a
 * runner rather than a hook, so the price is the command and not the editor
 * session — a real difference in severity, and none at all in the fix.
 *
 * DELETED IN FAVOUR OF THE SHARED READER, argued from the import graph rather
 * than from taste. This module ALREADY imports `readJsonResult` and
 * `writeJsonDurable` from shared/fsjson.ts (see above), and nothing under
 * `shared/` imports this file, so the edge exists in this direction today and
 * removing the copy adds none. Bounding in place would instead add a SECOND
 * edge — lib.ts → shared/bounded-read.ts — to keep a function whose body would
 * then be byte-for-byte fsjson's, i.e. a third structurally identical reader of
 * the kind bounded-read.ts's own header records finding twice already.
 *
 * The dependency-free hook-runtime rule does not object: it forbids npm
 * PACKAGES in `dist/scripts`, and fsjson.ts's transitive imports are `fs`,
 * `path` and four in-tree modules.
 */
export { readText };

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
 * Persist the shared project state, and report whether `.one.json` now holds it.
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
 *
 * ── Published through the fenced chokepoint, not raw `fs` ────────────────────
 * This module used to own a private `writeJson` built straight on `fs`, so the
 * canonical COMMITTED `.one.json` was the one state file published with no
 * consent fence, no symlink refusal and no containment check. A note here rated
 * that as defence in depth; CONSTRUCTING it showed one third of it was live.
 * With a directory symlink planted at `<project>/.traffic-one` on a CONSENTED
 * project, the whole report flow ran inside the link's target: `.one.json` (56
 * bytes) and `one-mcp-report.json` (740 bytes, carrying the collected MCP
 * payload) both landed outside the project root and prepareReport still returned
 * `started: true`. `withProjectStateLock` had already declined that same
 * directory — `ensureDir` refuses a link — so the transaction was unserialized
 * on top of being misdirected. writeJsonDurable is the identical recipe
 * (exclusive temp open, fsync, rename, directory fsync — fsjson lifted it from
 * here) behind the containment check that refuses the escape.
 *
 * A FINAL-component link at `.one.json` is genuinely harmless to the link's
 * TARGET: measured, rename replaces the link and the target stays byte-identical.
 * It is refused anyway, because fsjson refuses link-NESS rather than reasoning
 * about destinations — and because the read above resolves THROUGH such a link
 * and adopts the target's `one-uid`/`currentRunId` as the base it preserves.
 *
 * The consent fence changes nothing REACHABLE. prepareReport and runReport both
 * return `plugin-use-not-enabled` before any writer here is called, and
 * `pluginUseEnabled` is strictly STRONGER than the fence (with ask-first off and
 * no recorded answer, the fence permits and pluginUseEnabled still refuses). It
 * is here so the guarantee stops being the CALLER'S — a second caller inherits
 * it by construction instead of by call-graph accident.
 *
 * A refusal arrives on the channel an illegible base already uses: this `false`,
 * then createReportId's `unpersisted`, then prepareReport's
 * `unreadable-project-state`. Errnos are unchanged — the raw writer propagated
 * EACCES/ENOSPC/EISDIR and `act()` propagates them too — and the one new
 * symbolic outcome, ELOOP, is a check-then-open RACE rather than a durable
 * verdict, so it can differ between two calls a millisecond apart. None of it
 * reaches the pipeline's fail-closed `pipeline-handler-crashed` deny: that is
 * PreToolUse-only, this path is PostToolUse, and maybeStartOneMcpReport catches
 * everything on the way out.
 *
 * ONE deliberate behaviour change: a NEW `.one.json` now gets writeJsonDurable's
 * default mode (0644 under the usual umask) instead of the lifted recipe's 0600,
 * which is what state/normalize.ts writeState — the file's normal creator — has
 * always given it. An EXISTING destination's mode is preserved either way.
 */
export function writeProjectState(cwd: string, state: unknown): boolean {
  const filePath = statePath(cwd);
  const replacement = stripLocalPreferenceFields(state && typeof state === 'object' ? state : {});
  let persisted = false;
  withProjectStateLock(cwd, () => {
    const read = readJsonResult<Rec>(filePath);
    if (read.kind === 'corrupt' || read.kind === 'unreadable') return;
    const current = read.kind === 'ok' ? read.value : {};
    persisted = writeJsonDurable(filePath, preserveCurrentRunId(current, preserveOneMcpReportId(current, replacement)));
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
