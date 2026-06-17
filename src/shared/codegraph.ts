// src/shared/codegraph.ts
// Single source of truth for WHERE code-graph artifacts live. They live UNDER
// .traffic-one/ (gitignored) instead of polluting the project root. The provider
// CLIs have no output-dir flag (graphify always writes ./graphify-out, gitnexus
// always writes ./.gitnexus), so the runners run the tool as usual and then
// RELOCATE its root-level output under .traffic-one/ after a successful scan.

import * as fs from 'fs';
import * as path from 'path';

import { SKIP_DIRS, SKIP_FILES } from '../config/reporting';
import { SOURCE_EXTS } from './detection';
import { globToRegExp } from './scope';

// Where the tools write (project root) — no output-dir flag exists.
export const GRAPHIFY_OUT_ROOT_DIRNAME = 'graphify-out';
export const GITNEXUS_ROOT_DIRNAME = '.gitnexus';

// Where Traffic One keeps them (relative to the project root).
export const GRAPHIFY_OUT_REL = path.join('.traffic-one', 'graphify-out');
export const GRAPHIFY_REPORT_REL = path.join(GRAPHIFY_OUT_REL, 'GRAPH_REPORT.md');
export const GRAPHIFY_GRAPH_JSON_REL = path.join(GRAPHIFY_OUT_REL, 'graph.json');
export const GITNEXUS_REL = path.join('.traffic-one', '.gitnexus');

// Plugin/host-generated paths that are NOT project source — they must be kept
// out of the code-graph scan, or the graph indexes Traffic One's own docs
// instead of the user's code (observed: a 1074-node graph of .traffic-one/rules
// + skills on a project with zero source files). graphify gets these via
// `--exclude`; gitnexus via a scoped .gitnexusignore (it has no --exclude flag,
// and only built-in-excludes .claude/.cursor/AGENTS.md/CLAUDE.md — not .traffic-one).
// node_modules/dist/.git etc. are already both tools' built-in skips.
export const CODE_GRAPH_SCAN_EXCLUDES = ['.traffic-one', '.claude', '.cursor', 'AGENTS.md', 'CLAUDE.md'];

// A graphify graph built on a pre-scaffold/empty project serialises an empty
// node-link document (`{"nodes":[],"links":[],...}`, ~110 bytes). Its mtime is
// recent but it predates the real code, so the 7-day freshness window cannot
// tell it apart from a real index. The runner + its consumers treat a 0-node
// graph.json as stale so the next build/session rebuilds it once code exists —
// the graphify analogue of gitnexusGraphIsEmpty (which reads .gitnexus/meta.json).
//
// graphify writes no small stats file, only graph.json — which is multi-MB on a
// real repo (rules/common/codebase-graph.md warns against reading it whole). A
// populated graph is far larger than any empty serialisation, so a clearly-large
// file is skipped without parsing: this keeps the freshness fast-path cheap and
// never misreports a real graph as empty (the only "empty" graph.json is tiny).
// Missing/unparseable graph.json → can't tell → NOT empty (don't force a
// needless rebuild), matching gitnexus's catch behaviour.
const GRAPHIFY_EMPTY_MAX_BYTES = 64 * 1024;

export function graphifyGraphIsEmpty(cwd: string): boolean {
  try {
    const graphPath = path.join(cwd, GRAPHIFY_GRAPH_JSON_REL);
    const size = fs.statSync(graphPath).size;
    if (size > GRAPHIFY_EMPTY_MAX_BYTES) return false; // far too large to be empty
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as { nodes?: unknown };
    const nodes = graph.nodes;
    const count = Array.isArray(nodes) ? nodes.length : Number(nodes);
    return Number.isFinite(count) && count === 0;
  } catch {
    return false; // no/unreadable graph.json → can't tell → don't force a rebuild
  }
}

// gitnexus analogue: a pre-scaffold/empty index records `stats.files: 0` (or
// `stats.nodes: 0`) in .traffic-one/.gitnexus/meta.json. Lives here (not in the
// gitnexus runner) so runner-free consumers — session-start, graph-preview — can
// detect emptiness without importing a runner. The runner re-exports it.
export function gitnexusGraphIsEmpty(cwd: string): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cwd, GITNEXUS_REL, 'meta.json'), 'utf8')) as { stats?: { files?: unknown; nodes?: unknown } };
    const stats = meta && typeof meta.stats === 'object' && meta.stats ? meta.stats : null;
    if (!stats) return false;
    const files = Number(stats.files);
    const nodes = Number(stats.nodes);
    return (Number.isFinite(files) && files === 0) || (Number.isFinite(nodes) && nodes === 0);
  } catch {
    return false; // no/unreadable meta → can't tell → don't force a rebuild
  }
}

// Provider-agnostic emptiness check. Unknown provider → not empty (don't force).
export function codeGraphIsEmpty(cwd: string, provider: string): boolean {
  if (provider === 'graphify') return graphifyGraphIsEmpty(cwd);
  if (provider === 'gitnexus') return gitnexusGraphIsEmpty(cwd);
  return false;
}

// True when ANY project source file is newer than the code-graph index (its
// report/dir mtime, passed as `indexMtimeMs`) — i.e. the index predates recent
// code and must rebuild even inside the 7-day freshness window. This is what
// makes refresh correct regardless of the orchestrator/host: fix-cycle edits,
// ad-hoc edits, or a crash that dropped the parent-side --force step all leave
// source newer than the index, so the NEXT runner invocation self-heals.
//
// Reuses the report scanner's SKIP_DIRS/SKIP_FILES — critically excluding
// .traffic-one, .gitnexus, graphify-out, node_modules, dist, .git — so the
// freshly-written graph (and irrelevant generated trees) never mark themselves
// stale. Early-exits on the first newer file (cheap in the common stale case);
// bounded by a node cap so a pathological tree can't stall the freshness path
// (over the cap or on any error → assume fresh, never force a needless rebuild).
const STALE_WALK_MAX_NODES = 20000;

export function codeGraphIndexIsStale(cwd: string, indexMtimeMs: number): boolean {
  if (!(indexMtimeMs > 0)) return false; // unknown index time → can't tell → not stale
  let budget = STALE_WALK_MAX_NODES;
  const stack: string[] = [cwd];
  try {
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (--budget <= 0) return false; // too large to scan cheaply → assume fresh
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
        } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
          let m = 0;
          try { m = fs.statSync(path.join(dir, entry.name)).mtimeMs; } catch { continue; }
          if (m > indexMtimeMs) return true; // a source file is newer than the index
        }
      }
    }
  } catch {
    return false; // walk failed → can't tell → don't force a rebuild
  }
  return false;
}

// Neither provider's scan command takes a `--exclude` flag (verified: `graphify
// update --exclude` errors with "unknown update option"). Both honor a root
// ignore FILE (gitignore syntax) read by their scan: graphify → `.graphifyignore`
// (detect.py `_load_graphifyignore`), gitnexus → `.gitnexusignore` (loadIgnoreRules).
// Temporarily ensure the given patterns are excluded for the duration of a scan,
// then RESTORE the prior state — so the project root is never permanently altered
// (mirrors the graphify-out relocate-after pattern) and a user's own ignore file
// is left untouched. Returns a restore() to call after the scan. Best-effort: on
// any error it returns a no-op restore and the scan proceeds without the exclusion.
//
// seedFromGitignore: graphify reads `.graphifyignore` INSTEAD of `.gitignore`
// per-directory, so a freshly-created `.graphifyignore` would shadow the user's
// root `.gitignore`. When set, seed the temp file with the existing `.gitignore`
// first so the user's patterns are preserved alongside ours. (gitnexus reads BOTH
// files, so it doesn't need seeding.)
// --- Degenerate-seed guard --------------------------------------------------
// Seeding `.graphifyignore` from a project `.gitignore` (above) is the vector for
// a real failure: a sparse repo whose only source sits under a gitignored path, or
// an allowlist-style `.gitignore` (`*` + `!keep`), makes the seeded ignore exclude
// ALL source → graphify exits "No code files found - nothing to rebuild". graphify
// 0.8.x already reads `.gitignore` per-directory itself, so the seed is redundant
// for that — and dropping it when it would zero out the scan is safe (graphify's
// built-in skips + native .gitignore reading still exclude node_modules/dist/.git).

// Compile gitignore-style patterns into a path tester. Negations (`!…`) and
// comments are skipped, so the result leans toward classifying paths as ignored —
// the SAFE direction here (a false "all ignored" only drops the redundant seed; a
// false "not all" just lets graphify decide). A pattern with an internal slash (or
// a leading `/`) is root-anchored and tested against each path prefix; a slashless
// pattern matches any single path segment (gitignore's "match at any depth").
function compilePositiveIgnore(patterns: string[]): (relPath: string) => boolean {
  const tests: Array<{ rx: RegExp; anchored: boolean }> = [];
  for (const raw of patterns) {
    let pat = (raw || '').trim();
    if (!pat || pat.startsWith('#') || pat.startsWith('!')) continue;
    if (pat.endsWith('/')) pat = pat.slice(0, -1); // dir marker — prefix test covers it
    const rooted = pat.startsWith('/');
    if (rooted) pat = pat.slice(1);
    if (!pat) continue;
    tests.push({ rx: globToRegExp(pat), anchored: rooted || pat.includes('/') });
  }
  return (relPath) => {
    const segs = relPath.split('/');
    let prefix = '';
    const prefixes = segs.map((s) => (prefix = prefix ? `${prefix}/${s}` : s));
    for (const { rx, anchored } of tests) {
      if (anchored ? prefixes.some((p) => rx.test(p)) : segs.some((s) => rx.test(s))) return true;
    }
    return false;
  };
}

const IGNORE_WALK_MAX_NODES = 20000;

// Cheap, conservative pre-check: returns true iff source files EXIST under `cwd`
// (built-in skips only) but EVERY one would be matched by `ignorePatterns`. Walks
// into ignored dirs too (so source under an ignored path is still SEEN, then tested
// via its ancestor prefixes), bounded by a node cap → over the cap or any error
// returns false (assume not-all-ignored; keep the seed).
export function wouldIgnoreAllSource(cwd: string, ignorePatterns: string[]): boolean {
  const isIgnored = compilePositiveIgnore(ignorePatterns);
  let sawSource = false;
  let budget = IGNORE_WALK_MAX_NODES;
  const stack: string[] = [''];
  try {
    while (stack.length > 0) {
      const rel = stack.pop() as string;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(cwd, rel || '.'), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (--budget <= 0) return false; // too large to scan cheaply → keep the seed
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(childRel);
        } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
          sawSource = true;
          if (!isIgnored(childRel)) return false; // a source file SURVIVES → not all ignored
        }
      }
    }
  } catch {
    return false; // walk failed → can't tell → keep the seed
  }
  return sawSource; // source existed but none survived → all ignored
}

export function applyCodeGraphScanIgnore(
  cwd: string,
  ignoreFilename: string,
  patterns: string[],
  opts: { seedFromGitignore?: boolean } = {},
): () => void {
  const ignorePath = path.join(cwd, ignoreFilename);
  let existed = false;
  let prev: string | null = null;
  try {
    existed = fs.existsSync(ignorePath);
    prev = existed ? fs.readFileSync(ignorePath, 'utf8') : null;
    let seed = prev || '';
    let seededFromGitignore = false;
    if (!existed && opts.seedFromGitignore) {
      try { seed = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'); seededFromGitignore = true; } catch { seed = ''; }
    }
    // Degenerate-seed guard: if the .gitignore seed would make graphify scan zero
    // source files, drop it and write only our own patterns (which never match
    // source). Only when we actually seeded from .gitignore — never override a
    // user's explicit ignore file or our own bare patterns.
    if (seededFromGitignore && seed.trim() && wouldIgnoreAllSource(cwd, seed.split('\n').concat(patterns))) {
      seed = '';
    }
    const present = new Set(seed.split('\n').map((s) => s.trim()).filter(Boolean));
    const missing = patterns.filter((p) => !present.has(p));
    if (missing.length === 0) return () => {}; // already covered (user file or seeded .gitignore)
    const base = seed.length && !seed.endsWith('\n') ? `${seed}\n` : seed;
    fs.writeFileSync(ignorePath, `${base}${missing.join('\n')}\n`, 'utf8');
  } catch {
    return () => {}; // best-effort; scan runs without the exclusion rather than failing
  }
  return () => {
    try {
      if (existed && prev != null) fs.writeFileSync(ignorePath, prev, 'utf8');
      else fs.rmSync(ignorePath, { force: true });
    } catch {
      // best-effort; a leftover ignore file is harmless and gitignore-correct
    }
  };
}

// Move a tool's root-level output dir under .traffic-one/. No-op if the source
// is missing. cwd and cwd/.traffic-one are the same filesystem → rename is atomic.
// Best-effort: a relocation failure leaves the artifact in root rather than
// throwing (the caller's "produced?" check then reports it).
export function relocateUnderTrafficOne(cwd: string, rootDirname: string, destRel: string): void {
  const src = path.join(cwd, rootDirname);
  if (!fs.existsSync(src)) return;
  const dest = path.join(cwd, destRel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
  } catch {
    // best-effort; leave the artifact in place rather than throw
  }
}

// Graph providers (gitnexus today) also auto-write agent skills under
// .claude/skills/ — sometimes grouped (e.g. .claude/skills/gitnexus/<name>/).
// Those belong with Traffic One's per-project skills: move every LEAF skill dir
// (a dir containing SKILL.md) into .traffic-one/skills/<name>/ so they live
// beside the materialized set (the materializer's cleanup never touches them —
// they are not manifest-tracked). Existing destinations are preserved; emptied
// group dirs (and an emptied .claude/skills) are removed. Returns the relocated
// skill names. Best-effort: never throws.
export function relocateProviderSkills(cwd: string): string[] {
  const sourceRoot = path.join(cwd, '.claude', 'skills');
  const destRoot = path.join(cwd, '.traffic-one', 'skills');
  const relocated: string[] = [];
  try {
    if (!fs.existsSync(sourceRoot)) return relocated;

    const leafSkillDirs: string[] = [];
    const collect = (dir: string): void => {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        leafSkillDirs.push(dir);
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) collect(path.join(dir, entry.name));
      }
    };
    collect(sourceRoot);

    for (const skillDir of leafSkillDirs) {
      const name = path.basename(skillDir);
      const dest = path.join(destRoot, name);
      try {
        if (fs.existsSync(dest)) continue; // never clobber an existing skill
        fs.mkdirSync(destRoot, { recursive: true });
        fs.renameSync(skillDir, dest);
        relocated.push(name);
      } catch {
        // best-effort per skill
      }
    }

    // Sweep now-empty group dirs, then .claude/skills (and .claude) if emptied.
    const removeIfEmpty = (dir: string): void => {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // best-effort
      }
    };
    try {
      for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) removeIfEmpty(path.join(sourceRoot, entry.name));
      }
    } catch {
      // best-effort
    }
    removeIfEmpty(sourceRoot);
    removeIfEmpty(path.join(cwd, '.claude'));
  } catch {
    // best-effort
  }
  return relocated.sort();
}
