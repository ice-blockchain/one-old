// src/shared/scope.ts
// Dependency-free path-scope matcher for explicit per-run write assignments.
// A subagent's scope is an include list (+ optional exclude carve-outs) of path
// patterns; a target path is "in scope" iff it matches >=1 include and 0 excludes.
// Patterns are project-relative, '/'-separated, and are either a literal prefix
// (matches the exact file or any path under that directory) or a glob using
// `*` (within a path segment), `**` (across segments), and `?` (single non-slash).
// Pure: no fs, no other module imports, so the gate and the architect's
// disjointness check can both reuse it and it is trivially unit-testable.

type PathPattern = string;

export interface AssignedScope {
  include: PathPattern[];
  exclude?: PathPattern[];
}

// '\' -> '/', drop a leading './'. Mirrors applyPatchTargetPaths in feature-source.ts
// so manifest patterns and gate targets are compared in the same space.
export function normalizeRelPath(p: unknown): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

const GLOB_META = /[*?]/;
const globCache = new Map<string, RegExp>();

// Translate a glob pattern to an anchored RegExp. `**` matches across '/', `*`
// matches within a single segment, `?` matches one non-slash char; everything
// else is matched literally (regex metachars escaped). Results are memoized.
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\/'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  const compiled = new RegExp(`^${out}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

// Does `target` match a single pattern? A glob pattern is matched as a regex; a
// literal pattern matches the exact file path or anything under it as a directory
// prefix (so `src/app/` and `src/app` both match `src/app/page.tsx`, but neither
// matches `src/application.ts`).
export function matchesPattern(target: unknown, pattern: PathPattern): boolean {
  const t = normalizeRelPath(target);
  const p = normalizeRelPath(pattern);
  if (!p) return false;
  if (GLOB_META.test(p)) return globToRegExp(p).test(t);
  if (t === p) return true;
  const dir = p.endsWith('/') ? p : `${p}/`;
  return t.startsWith(dir);
}

// In scope iff it matches at least one include and none of the excludes.
export function matchesScope(target: unknown, scope: AssignedScope | null | undefined): boolean {
  if (!scope || !Array.isArray(scope.include) || scope.include.length === 0) return false;
  if (!scope.include.some((pat) => matchesPattern(target, pat))) return false;
  if (Array.isArray(scope.exclude) && scope.exclude.some((pat) => matchesPattern(target, pat))) return false;
  return true;
}

// Two scopes overlap if any probe path falls inside both. Used by the architect /
// tests to assert assignments are pairwise disjoint over a representative path set.
export function scopesOverlap(a: AssignedScope, b: AssignedScope, probes: string[]): boolean {
  return probes.some((probe) => matchesScope(probe, a) && matchesScope(probe, b));
}
