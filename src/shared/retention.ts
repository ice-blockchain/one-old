// src/shared/retention.ts
// Conservative .traffic-one retention sweep. Durable project memory is never
// touched; only correlated run artefacts and clearly-ephemeral logs/locks/backups
// are candidates. Dry-run by default.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from './fsjson';
import { obj } from './obj';

export interface RetentionPolicy {
  keepRuns: number;
  backupKeep: number;
  orphanTtlDays: number;
}

export interface RetentionAction {
  action: 'remove';
  path: string;
  reason: string;
}

export interface RetentionResult {
  cwd: string;
  dryRun: boolean;
  policy: RetentionPolicy;
  keepRunIds: string[];
  actions: RetentionAction[];
  removed: number;
}

const DEFAULT_POLICY: RetentionPolicy = {
  keepRuns: 5,
  backupKeep: 3,
  orphanTtlDays: 7,
};

function readPolicy(cwd: string): RetentionPolicy {
  const raw = obj(readJson(path.join(cwd, '.traffic-one', 'retention.json'), null));
  if (!raw) return DEFAULT_POLICY;
  const keepRuns = Number(raw.keepRuns);
  const backupKeep = Number(raw.backupKeep);
  const orphanTtlDays = Number(raw.orphanTtlDays);
  return {
    keepRuns: Number.isFinite(keepRuns) && keepRuns >= 1 ? Math.floor(keepRuns) : DEFAULT_POLICY.keepRuns,
    backupKeep: Number.isFinite(backupKeep) && backupKeep >= 0 ? Math.floor(backupKeep) : DEFAULT_POLICY.backupKeep,
    orphanTtlDays: Number.isFinite(orphanTtlDays) && orphanTtlDays >= 0 ? orphanTtlDays : DEFAULT_POLICY.orphanTtlDays,
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

function keepRunIds(cwd: string, policy: RetentionPolicy): Set<string> {
  const current = readCurrentRunId(cwd);
  const ids = collectRunIds(cwd);
  const keep = new Set<string>();
  if (current) keep.add(current);
  for (const id of ids) {
    if (keep.size >= policy.keepRuns + (current ? 1 : 0)) break;
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

function collectActions(cwd: string, policy: RetentionPolicy, nowMs: number): { keep: Set<string>; actions: RetentionAction[] } {
  const t1 = path.join(cwd, '.traffic-one');
  const keep = keepRunIds(cwd, policy);
  const actions: RetentionAction[] = [];

  for (const rel of ['runs', 'digests', 'fix-cycles', path.join('reports', 'qa')]) {
    const root = path.join(t1, rel);
    for (const id of listDirs(root)) {
      if (id === '.once') continue;
      if (!keep.has(id)) maybeAction(actions, path.join(root, id), `older than retained run set (${policy.keepRuns})`);
    }
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

  for (const rel of [path.join('reports', 'lighthouse'), 'logs']) {
    const root = path.join(t1, rel);
    for (const name of [...listDirs(root), ...listFiles(root)]) {
      const target = path.join(root, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale ${rel} artefact older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  return { keep, actions };
}

export function sweepTrafficOneRetention(cwd: string, opts: { dryRun?: boolean; nowMs?: number } = {}): RetentionResult {
  const dryRun = opts.dryRun !== false;
  const policy = readPolicy(cwd);
  const { keep, actions } = collectActions(cwd, policy, opts.nowMs ?? Date.now());
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
