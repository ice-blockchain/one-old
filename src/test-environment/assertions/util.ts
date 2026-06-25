// src/test-environment/assertions/util.ts
// Small shared helpers for assertions: authentic effective-state reads (reusing
// the real source merge) and strict-safe accessors over unknown JSON.

import * as fs from 'fs';
import * as path from 'path';

import { obj, type Rec } from '../../shared/obj';
import { readEffectiveState } from '../../shared/state/local-prefs';
import type { AssertionContext, AssertionResult, AssertionStatus, HostRunStatus } from '../core/types';

// A host run "produced work" if it ran the agent at all — COMPLETED, or TIMEOUT
// (killed mid-flight but the partial project/state is real evidence). ERROR
// (e.g. 401), SKIPPED, and NOT_RUN produced nothing to inspect.
export function hostProducedWork(status: HostRunStatus): boolean {
  return status === 'COMPLETED' || status === 'TIMEOUT';
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.traffic-one']);

// True if `rel` exists at the project root, OR a file with the same basename
// exists anywhere in the tree (so an `src/App.tsx` expectation matches the
// plugin's `apps/web/src/App.tsx` monorepo layout). Bounded walk.
export function projectHasFile(root: string, rel: string): boolean {
  if (fs.existsSync(path.join(root, rel))) return true;
  const target = path.basename(rel);
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 7) return false;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (walk(path.join(dir, e.name), depth + 1)) return true;
      } else if (e.name === target) {
        return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

export function effState(ctx: AssertionContext): Rec {
  return readEffectiveState(ctx.cwd, ctx.env);
}

export function rec(value: unknown): Rec {
  return obj(value) ?? {};
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function result(
  ctx: AssertionContext,
  status: AssertionStatus,
  detail: string,
  extra?: { expected?: unknown; actual?: unknown },
): AssertionResult {
  return {
    id: ctx.spec.id,
    title: '', // filled by case-runner from the Assertion definition
    status,
    detail,
    expected: extra?.expected,
    actual: extra?.actual,
  };
}

export function readJsonFile(file: string): Rec | null {
  try {
    if (!fs.existsSync(file)) return null;
    return obj(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// Newest run id from .traffic-one/runs + /digests (or state.currentRunId).
export function latestRunId(cwd: string, state: Rec): string | null {
  const explicit = str(state.currentRunId);
  if (explicit) return explicit;
  const candidates = new Set<string>();
  for (const sub of ['runs', 'digests']) {
    const dir = path.join(cwd, '.traffic-one', sub);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^\d+$/.test(name)) candidates.add(name);
      }
    } catch { /* dir absent */ }
  }
  const sorted = [...candidates].sort((a, b) => Number(b) - Number(a));
  return sorted[0] ?? null;
}
