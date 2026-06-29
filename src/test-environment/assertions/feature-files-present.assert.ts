// feature-files-present: the host actually produced the files (and optional text)
// the prompt asked for. Host-e2e only; driven entirely by spec.params so cases
// declare what to look for:
//   params.paths:    string[]            relative paths that must exist
//   params.contains: { path, text }[]    a file that must contain text
//   params.anyOf:    string[]            at least one of these must exist
//
// Path matching is layout-aware: an `src/App.tsx` expectation also matches the
// plugin's monorepo scaffold at `apps/web/src/App.tsx` (basename fallback).
// On a TIMEOUT the build was cut off, so a missing file is INCONCLUSIVE, not FAIL.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import { result, hostProducedWork, projectHasFile } from './util';

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function findFile(root: string, rel: string): string | null {
  const exact = path.join(root, rel);
  if (fs.existsSync(exact)) return exact;
  const target = path.basename(rel);
  const ignore = new Set(['node_modules', '.git', '.traffic-one']);
  const stack = [root];
  let depth = 0;
  while (stack.length && depth < 10000) {
    depth++;
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!ignore.has(e.name)) stack.push(path.join(dir, e.name)); }
      else if (e.name === target) return path.join(dir, e.name);
    }
  }
  return null;
}

export const assertion: Assertion = {
  id: 'feature-files-present',
  title: 'Requested feature files present',
  appliesTo: (c) => c.layer === 'host-e2e',
  run: (ctx) => {
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced nothing to inspect (${ctx.hostResult.status}).`);
    }
    const cutOff = ctx.hostResult.status === 'TIMEOUT'; // build interrupted → misses are INCONCLUSIVE
    const p = ctx.spec.params ?? {};
    const paths = asStrArray(p.paths);
    const anyOf = asStrArray(p.anyOf);
    const contains = Array.isArray(p.contains) ? p.contains : [];
    if (paths.length === 0 && anyOf.length === 0 && contains.length === 0) {
      return result(ctx, 'SKIP', 'No feature-file expectations declared (spec.params empty).');
    }

    const problems: string[] = [];
    for (const rel of paths) {
      if (!projectHasFile(ctx.cwd, rel)) problems.push(`missing ${rel}`);
    }
    if (anyOf.length > 0 && !anyOf.some((rel) => projectHasFile(ctx.cwd, rel))) {
      problems.push(`none of [${anyOf.join(', ')}] exist`);
    }
    for (const entry of contains) {
      const e = entry as { path?: unknown; text?: unknown };
      if (typeof e.path !== 'string' || typeof e.text !== 'string') continue;
      const full = findFile(ctx.cwd, e.path);
      if (!full) { problems.push(`missing ${e.path} (for contains)`); continue; }
      if (!fs.readFileSync(full, 'utf8').includes(e.text)) problems.push(`${e.path} does not contain "${e.text}"`);
    }

    if (problems.length === 0) return result(ctx, 'PASS', 'All requested files/content present.');
    const detail = `Problems:\n - ${problems.join('\n - ')}`;
    return cutOff
      ? result(ctx, 'INCONCLUSIVE', `${detail}\n(build was cut off by TIMEOUT — may be incomplete)`)
      : result(ctx, 'FAIL', detail);
  },
};
