// src/shared/retention.ts
// Conservative .traffic-one retention sweep. Durable project memory is never
// touched; only correlated run artefacts and clearly-ephemeral logs/locks/backups
// are candidates. Dry-run by default.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from './fsjson';
import { resolveProjectRoot } from './hook/paths';
import { obj } from './obj';

interface RetentionPolicy {
  keepRuns: number;
  backupKeep: number;
  orphanTtlDays: number;
  /** Newest Lighthouse runs kept per route; older ones are superseded copies. */
  lighthouseKeepPerRoute: number;
}

interface RetentionAction {
  action: 'remove';
  path: string;
  reason: string;
}

interface RetentionResult {
  cwd: string;
  dryRun: boolean;
  policy: RetentionPolicy;
  keepRunIds: string[];
  actions: RetentionAction[];
  removed: number;
}

// Tightened after the 12co audit: 5 retained runs held 113 files / 1.17 MB in
// `runs/` plus 9.5 MB of reports for a single settled run; backups were all
// byte-identical. One backup, three runs, and one Lighthouse pair per route
// cover every recovery path the runtime actually exercises.
const DEFAULT_POLICY: RetentionPolicy = {
  keepRuns: 3,
  backupKeep: 1,
  orphanTtlDays: 3,
  lighthouseKeepPerRoute: 1,
};

function readPolicy(cwd: string): RetentionPolicy {
  const raw = obj(readJson(path.join(cwd, '.traffic-one', 'retention.json'), null));
  if (!raw) return DEFAULT_POLICY;
  const keepRuns = Number(raw.keepRuns);
  const backupKeep = Number(raw.backupKeep);
  const orphanTtlDays = Number(raw.orphanTtlDays);
  const lighthouseKeepPerRoute = Number(raw.lighthouseKeepPerRoute);
  return {
    keepRuns: Number.isFinite(keepRuns) && keepRuns >= 1 ? Math.floor(keepRuns) : DEFAULT_POLICY.keepRuns,
    backupKeep: Number.isFinite(backupKeep) && backupKeep >= 0 ? Math.floor(backupKeep) : DEFAULT_POLICY.backupKeep,
    orphanTtlDays: Number.isFinite(orphanTtlDays) && orphanTtlDays >= 0 ? orphanTtlDays : DEFAULT_POLICY.orphanTtlDays,
    lighthouseKeepPerRoute: Number.isFinite(lighthouseKeepPerRoute) && lighthouseKeepPerRoute >= 1
      ? Math.floor(lighthouseKeepPerRoute)
      : DEFAULT_POLICY.lighthouseKeepPerRoute,
  };
}

function listDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFiles(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// A nested `.traffic-one/.one.json` is a LEAK (safe to remove) ONLY when it does not
// belong to its OWN independent project. We delegate that judgement to
// resolveProjectRoot — the single source of truth the write-side and every gate use —
// so cleanup can never disagree with the resolver. A genuine independent onboarded
// project (a mode-bearing `.one.json` with NO workspace ancestor) resolves to ITSELF
// and is kept; a monorepo sub-package's stray/leaked state (the packages/ui incident)
// resolves UP to the enclosing workspace root, so it differs from its own dir and is a
// deletion candidate. This mirrors nearestWorkspaceRoot/dirDeclaresWorkspace — the same
// gate isUnclaimedWorkspaceSubPackage uses on the write side.
function isLeakedNestedRoot(projectDir: string): boolean {
  const dir = path.resolve(projectDir);
  try {
    return resolveProjectRoot(dir) !== dir;
  } catch {
    return false; // never delete on an indeterminate resolution
  }
}

function listNestedTrafficOneDirs(cwd: string): string[] {
  const out: string[] = [];
  const root = path.resolve(cwd);
  const trafficDir = '.traffic' + '-one';
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.pnpm-store']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= 50) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.name === trafficDir) {
        if (path.dirname(abs) !== root
          && fs.existsSync(path.join(abs, '.one.json'))
          && isLeakedNestedRoot(path.dirname(abs))) {
          out.push(abs);
        }
        continue;
      }
      walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function numericDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
}

function readCurrentRunId(cwd: string): string | null {
  const state = obj(readJson(path.join(cwd, '.traffic-one', '.one.json'), null));
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return runId || null;
}

function collectRunIds(cwd: string): string[] {
  const t1 = path.join(cwd, '.traffic-one');
  const ids = new Set<string>();
  for (const rel of ['runs', 'digests', 'fix-cycles', path.join('reports', 'qa')]) {
    for (const name of listDirs(path.join(t1, rel))) {
      if (name === '.once') continue;
      ids.add(name);
    }
  }
  const current = readCurrentRunId(cwd);
  if (current) ids.add(current);
  return [...ids].sort(numericDesc);
}

function keepRunIds(cwd: string, policy: RetentionPolicy, protectRunIds: readonly string[] = []): Set<string> {
  const current = readCurrentRunId(cwd);
  const ids = collectRunIds(cwd);
  const keep = new Set<string>();
  if (current) keep.add(current);
  // Caller-protected ids (the run being settled) are unconditional: a settle
  // of an OLDER run must never reclaim the ledger it wrote milliseconds ago.
  for (const id of protectRunIds) if (id) keep.add(id);
  const reserved = keep.size;
  for (const id of ids) {
    if (keep.size >= policy.keepRuns + reserved) break;
    keep.add(id);
  }
  return keep;
}

function maybeAction(actions: RetentionAction[], filePath: string, reason: string): void {
  actions.push({ action: 'remove', path: filePath, reason });
}

function isOlderThan(filePath: string, ttlMs: number, nowMs: number): boolean {
  try {
    return (nowMs - fs.statSync(filePath).mtimeMs) >= ttlMs;
  } catch {
    return false;
  }
}

function collectActions(cwd: string, policy: RetentionPolicy, nowMs: number, protectRunIds: readonly string[] = []): { keep: Set<string>; actions: RetentionAction[] } {
  const t1 = path.join(cwd, '.traffic-one');
  const keep = keepRunIds(cwd, policy, protectRunIds);
  const actions: RetentionAction[] = [];

  for (const rel of ['runs', 'digests', 'fix-cycles', path.join('reports', 'qa')]) {
    const root = path.join(t1, rel);
    for (const id of listDirs(root)) {
      if (id === '.once') continue;
      if (!keep.has(id)) maybeAction(actions, path.join(root, id), `older than retained run set (${policy.keepRuns})`);
    }
  }

  // Runs that never reached a compiled architecture are not runs — they were
  // minted, captured a baseline, and abandoned. Observed 8cl: a run minted 3.5
  // minutes AFTER the previous one settled `agent-failed`, holding a 1.63 MB
  // baseline, still `status: active`, while `currentRunId` stayed on the earlier
  // run. Nothing reclaimed it because the keep-set counts it as one of the five
  // most recent. The TTL keeps an in-flight pre-PLAN_READY run untouched.
  const ttl = policy.orphanTtlDays * 24 * 60 * 60 * 1000;
  const currentRunId = readCurrentRunId(cwd);
  for (const id of listDirs(path.join(t1, 'runs'))) {
    if (id === '.once' || id === currentRunId || protectRunIds.includes(id)) continue;
    const runDir = path.join(t1, 'runs', id);
    if (actions.some((action) => action.path === runDir)) continue;
    if (fs.existsSync(path.join(runDir, 'architecture-v1.json'))) continue;
    if (!isOlderThan(runDir, ttl, nowMs)) continue;
    maybeAction(actions, runDir, `abandoned before architecture compilation and older than ${policy.orphanTtlDays} days`);
  }

  const backups = listDirs(path.join(t1, 'backups')).sort(numericDesc);
  for (const name of backups.slice(policy.backupKeep)) {
    maybeAction(actions, path.join(t1, 'backups', name), `older than retained backup set (${policy.backupKeep})`);
  }

  const ttlMs = policy.orphanTtlDays * 24 * 60 * 60 * 1000;
  for (const rel of [path.join('runs', '.once'), '.once']) {
    const root = path.join(t1, rel);
    for (const name of [...listDirs(root), ...listFiles(root)]) {
      const target = path.join(root, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale one-time marker older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  for (const rel of ['.codegraph-build-lock', '.opencode-heal-lock']) {
    const target = path.join(t1, rel);
    if (fs.existsSync(target) && (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs))) {
      maybeAction(actions, target, `stale lock older than ${policy.orphanTtlDays} days`);
    }
  }

  const debugRoot = path.join(t1, 'debug');
  for (const name of listFiles(debugRoot)) {
    const target = path.join(debugRoot, name);
    if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
      maybeAction(actions, target, `stale debug log older than ${policy.orphanTtlDays} days`);
    }
  }

  // Per-run diagnostic captures (claim-capture.jsonl, plan-guard-deny.jsonl)
  // live under runs/<id>/debug/ and were previously reclaimed only when the
  // whole run dir aged out of the keep set — RETAINED runs kept them forever.
  for (const id of listDirs(path.join(t1, 'runs'))) {
    if (id === '.once') continue;
    const runDebug = path.join(t1, 'runs', id, 'debug');
    for (const name of listFiles(runDebug)) {
      const target = path.join(runDebug, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale run debug log older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  for (const rel of [path.join('reports', 'lighthouse'), 'logs']) {
    const root = path.join(t1, rel);
    for (const name of [...listDirs(root), ...listFiles(root)]) {
      const target = path.join(root, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale ${rel} artefact older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  // Lighthouse reports carry a timestamp in their filename, so no run ever
  // supersedes the previous one and a TTL-only sweep keeps every copy inside the
  // window. Observed 9co: 10 HTML+JSON pairs, 13.6 MB, one run — while the actual
  // evidence artefact is an 863-byte `lighthouse-evidence-v1.json` in the QA dir.
  // Keep the newest few per route; the rest are superseded duplicates.
  const lighthouseRoot = path.join(t1, 'reports', 'lighthouse');
  // Reports are written run-scoped (`reports/lighthouse/<runId>/…`); pre-1.0.40
  // artefacts sit flat in the root, so both layouts are swept.
  for (const dir of ['', ...listDirs(lighthouseRoot)]) {
    const root = dir ? path.join(lighthouseRoot, dir) : lighthouseRoot;
    const byRoute = new Map<string, string[]>();
    for (const name of listFiles(root)) {
      if (actions.some((action) => action.path === path.join(root, name))) continue;
      // `<route>[-<buildTag>]-<ISO timestamp>.report.{json,html}` — group on the
      // route+build prefix, so a new build never supersedes another build's file.
      const match = /^(.*?)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.report\.(?:json|html)$/.exec(name);
      if (!match) continue;
      const bucket = byRoute.get(match[1]!) || [];
      bucket.push(name);
      byRoute.set(match[1]!, bucket);
    }
    for (const [, names] of byRoute) {
      // Two files per run (json + html), so keeping 2 runs means 4 files.
      for (const name of names.sort().reverse().slice(policy.lighthouseKeepPerRoute * 2)) {
        maybeAction(
          actions,
          path.join(root, name),
          `superseded Lighthouse report (keeping ${policy.lighthouseKeepPerRoute} per route)`,
        );
      }
    }
  }

  for (const nested of listNestedTrafficOneDirs(cwd)) {
    maybeAction(actions, nested, 'leaked nested Traffic One state root inside ancestor workspace');
  }

  return { keep, actions };
}

export function sweepTrafficOneRetention(cwd: string, opts: { dryRun?: boolean; nowMs?: number; protectRunIds?: readonly string[] } = {}): RetentionResult {
  const dryRun = opts.dryRun !== false;
  const policy = readPolicy(cwd);
  const { keep, actions } = collectActions(cwd, policy, opts.nowMs ?? Date.now(), opts.protectRunIds ?? []);
  let removed = 0;
  if (!dryRun) {
    for (const action of actions) {
      try {
        fs.rmSync(action.path, { recursive: true, force: true });
        removed += 1;
      } catch {
        // best-effort; never abort cleanup because one path is busy
      }
    }
  }
  return {
    cwd,
    dryRun,
    policy,
    keepRunIds: [...keep].sort(numericDesc),
    actions,
    removed,
  };
}

// Post-settlement trigger: reclaim superseded artefacts the moment a run reaches
// a terminal ledger state instead of waiting for the next SessionStart (observed
// 12co: 113 run files + 9.5 MB of reports sat untouched until a later session
// swept). Runs strictly AFTER the terminal ledger write. The settled run id is
// protected EXPLICITLY: `currentRunId` alone is not enough — the deny remedies
// legitimately settle OLDER runs (blocked/failed cleanup), and an adversarial
// review proved the keep-window could reclaim the very ledger such a settle
// wrote milliseconds earlier.
export function sweepAfterTerminalSettlement(cwd: string, settledRunId?: string): void {
  try {
    sweepTrafficOneRetention(cwd, {
      dryRun: false,
      ...(settledRunId ? { protectRunIds: [settledRunId] } : {}),
    });
  } catch {
    // best-effort: settlement must never fail because cleanup did
  }
}

// Enforce the backup cap at WRITE time. The full sweep only runs at SessionStart,
// so a session that re-bootstraps the code graph N times accumulates N snapshots
// (measured: 9 in 18 minutes under `backupKeep: 3`, all byte-identical). `keepName`
// is the snapshot the caller may still restore from — never a candidate — and at
// least one snapshot always survives even when the policy asks for zero.
export function pruneTrafficOneBackups(cwd: string, keepName?: string): number {
  const root = path.join(cwd, '.traffic-one', 'backups');
  const keep = Math.max(1, readPolicy(cwd).backupKeep);
  let removed = 0;
  for (const name of listDirs(root).sort(numericDesc).slice(keep)) {
    if (keepName && name === keepName) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; never abort a bootstrap because one path is busy
    }
  }
  return removed;
}
