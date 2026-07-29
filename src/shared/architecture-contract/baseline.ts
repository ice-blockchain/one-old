// src/shared/architecture-contract/baseline.ts
// The immutable baseline: git/file-manifest capture, skip rules, stray-
// artifact deletability, context-alias links, and snapshot/baseline IO.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  capabilityProfileForProject,
  detectFrontendFramework,
  runtimeCapabilityStateFromProfile,
  type CapabilityProfileV1,
} from '../capabilities';
import { readJson, writeJson } from '../fsjson';
import { sha256 } from '../text';

import {
  ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION,
  ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
  ARCHITECTURE_SCAN_MAX_FILES,
  type ArchitectureBaselineV1,
  type ArchitectureRunBaselineV1,
  type ArchitectureRunSnapshotV1,
  type CompiledArchitectureV1,
} from './types';
import {
  MEMORY_DIR,
  contractHash,
  normalizeRelative,
  baselineContains,
} from './core';

export function baselinePathSet(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
): Set<string> {
  if (baseline.kind === 'file-manifest') {
    return new Set([
      ...(baseline.files || []).map((entry) => entry.path),
      ...(baseline.directories || []),
    ]);
  }
  if (!baseline.identity.startsWith('git:')) {
    throw new Error('immutable Git baseline identity is invalid');
  }
  let output: string;
  let prefix = '';
  try {
    prefix = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\\/g, '/');
    output = execFileSync('git', [
      '-C', projectRoot, 'ls-tree', '-r', '--name-only', baseline.identity.slice(4),
      ...(prefix ? ['--', prefix] : []),
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('immutable Git baseline tree cannot be read');
  }
  const files = output.split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => !prefix || entry.startsWith(prefix))
    .map((entry) => prefix ? entry.slice(prefix.length) : entry)
    .filter(Boolean);
  if (files.length > ARCHITECTURE_SCAN_MAX_FILES) {
    throw new Error(`baseline tree exceeds ${ARCHITECTURE_SCAN_MAX_FILES} files`);
  }
  return new Set(files);
}


/**
 * Is `relPath` a stray by-product safe to delete outright — present on disk,
 * owned by nobody in the compiled contract, and absent from the immutable
 * baseline? A role that produced a file outside its allowlist otherwise cannot
 * remove it (observed 6co: `apps/web/public/icons/favicon.svg.png` was denied to
 * the frontend AND to the parent), so a deadlock only an exact `git clean`
 * escaped. Fail CLOSED: anything unreadable, tracked, compiled, or outside the
 * project is not deletable through this path.
 */
export function isDeletableStrayArtifact(
  projectRoot: string,
  relPath: string,
  architecture: CompiledArchitectureV1 | null,
): boolean {
  const normalized = normalizeRelative(relPath);
  if (!normalized || !architecture) return false;
  if (/(?:^|\/)(?:\.git|\.traffic-one)(?:\/|$)/.test(normalized)) return false;
  const absolute = path.join(projectRoot, normalized);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  // Never a compiled output: deleting one is a contract change, not cleanup.
  const compiled = new Set([
    ...(architecture.scaffoldOutputs || []).map((output) => output.path),
    ...(architecture.modules || []).map((module) => module.output),
  ]);
  if (compiled.has(normalized)) return false;
  let baselinePaths: ReadonlySet<string>;
  try {
    baselinePaths = baselinePathSet(projectRoot, architecture.baseline);
  } catch {
    return false;
  }
  if (baselineContains(baselinePaths, normalized)) return false;
  // A Git baseline lists HEAD, not the index — a file staged after capture is
  // tracked and must not vanish through a cleanup carve-out.
  if (architecture.baseline.kind === 'git-head') {
    try {
      execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', normalized], {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return false;
    } catch {
      // not tracked — the only branch that permits deletion
    }
  }
  return true;
}

function findGitDir(projectRoot: string): string | null {
  let cursor = path.resolve(projectRoot);
  while (true) {
    const dotGit = path.join(cursor, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (match?.[1]) return path.resolve(cursor, match[1]);
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function gitHead(projectRoot: string): string | null {
  const gitDir = findGitDir(projectRoot);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40,64}$/i.test(head)) return head.toLowerCase();
    const ref = /^ref:\s+(.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const direct = path.join(gitDir, ref);
    try {
      const value = fs.readFileSync(direct, 'utf8').trim();
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
      const value = line?.split(' ')[0] || '';
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

const BASELINE_SKIP_RE = /(^|\/)(?:\.git|\.traffic-one|node_modules|dist|build|coverage|out|\.next|\.turbo|generated|__generated__|test-results|playwright-report)(?:\/|$)/;

// Package-manager and toolchain by-products of the MANDATORY workflow steps —
// not authored source. A lockfile appears the moment an implementer installs
// the dependency a completion gate itself demanded (observed 5co-codex: the
// format-parity gate required `prettier`, `pnpm install` wrote pnpm-lock.yaml,
// and the verification refresh then denied every subsequent `IMPLEMENTED` as
// "changed paths outside the frozen verification/WorkUnit authority" — a
// permanent deadlock on an otherwise green run; the tester's Playwright run
// added `test-results/.last-run.json` the same way and the canonical QA
// runner rejected the whole manifest). These files are excluded from BOTH the
// immutable baseline capture and every later scan, so they can never appear
// as unauthorized changed paths — keep the two sides in exact agreement.
const DERIVED_ARTIFACT_FILE_RE =
  /(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|deno\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|[^/]*\.tsbuildinfo|\.DS_Store)$/;

/**
 * True when `relativePath` must be invisible to baseline capture and to every
 * baseline-derived diff (verification refresh, QA evidence manifest). Shared by
 * `architecture-contract` (capture) and `verification-contract` (compare) so
 * the two scans can never disagree about a derived artifact.
 */
export function isScanSkippedPath(relativePath: string): boolean {
  return BASELINE_SKIP_RE.test(`/${relativePath}`)
    || DERIVED_ARTIFACT_FILE_RE.test(`/${relativePath}`);
}

const CONTEXT_ALIAS_PATH = 'CLAUDE.md';
const CONTEXT_ALIAS_TARGET = 'AGENTS.md';

/**
 * Identity row for the canonical context alias. Both the immutable baseline and
 * the verification diff hash it this way, so replacing the alias with a regular
 * file (or another link) still shows up as a change in either scan.
 */
export function contextAliasHash(target: string): string {
  return sha256(`symbolic-link:${target}`);
}

/**
 * The ONE symlink materialization creates in a project root: `CLAUDE.md` →
 * `AGENTS.md`. Returns the link target when `relativePath` is exactly that
 * alias, else null.
 *
 * Exported because every scan that walks project files has to agree about it.
 * The immutable baseline accepted the alias while the verification scan failed
 * closed on it, so the plugin's own materialized artifact denied `PLAN_READY`
 * with `STRUCT_SCAN_INCOMPLETE` (observed 1cu-cursor; the parent had to replace
 * the symlink with a copy by hand to get the run moving).
 */
export function canonicalTrafficOneContextLink(
  projectRoot: string,
  fullPath: string,
  relativePath: string,
): string | null {
  // Materialization owns exactly this root alias. Keep every other symlink
  // fail-closed: source links, nested aliases, absolute targets, and escapes
  // must never disappear from an immutable non-Git baseline.
  if (relativePath !== CONTEXT_ALIAS_PATH) return null;
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(fullPath);
  } catch {
    return null;
  }
  if (linkTarget !== CONTEXT_ALIAS_TARGET) return null;
  const expectedTarget = path.join(path.resolve(projectRoot), CONTEXT_ALIAS_TARGET);
  const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
  if (resolvedTarget !== expectedTarget) return null;
  try {
    const targetStat = fs.lstatSync(resolvedTarget);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return linkTarget;
}

function fileManifestBaseline(projectRoot: string, roots: string[]): ArchitectureBaselineV1 {
  const rows: Array<[string, string]> = [];
  const directories: string[] = [];
  const stack = roots
    .map((root) => normalizeRelative(root))
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(projectRoot, root));
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      const rel = path.relative(projectRoot, dir).replace(/\\/g, '/') || '.';
      throw new Error(`baseline cannot read ${rel}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (isScanSkippedPath(rel)) continue;
      if (entry.isSymbolicLink()) {
        const target = canonicalTrafficOneContextLink(projectRoot, full, rel);
        if (target) {
          scanned += 1;
          if (scanned > ARCHITECTURE_SCAN_MAX_FILES) {
            throw new Error(`baseline scan exceeds ${ARCHITECTURE_SCAN_MAX_FILES} files`);
          }
          // The target file is hashed independently. This row additionally
          // makes replacing the canonical alias with another filesystem shape
          // visible in the immutable baseline identity.
          rows.push([rel, contextAliasHash(target)]);
          continue;
        }
        throw new Error(`baseline cannot include symbolic link ${rel}`);
      }
      if (entry.isDirectory()) {
        directories.push(rel);
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (scanned > ARCHITECTURE_SCAN_MAX_FILES) {
        throw new Error(`baseline scan exceeds ${ARCHITECTURE_SCAN_MAX_FILES} files`);
      }
      let bytes: Buffer;
      try { bytes = fs.readFileSync(full); } catch {
        throw new Error(`baseline cannot read ${rel}`);
      }
      rows.push([rel, sha256(bytes.toString('base64'))]);
    }
  }
  rows.sort(([a], [b]) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  const filesHash = contractHash({ files: rows, directories });
  return {
    kind: 'file-manifest',
    identity: `files:${filesHash}`,
    capturedAt: new Date().toISOString(),
    filesHash,
    fileCount: rows.length,
    files: rows.map(([filePath, hash]) => ({ path: filePath, hash })),
    directories,
  };
}

export function captureArchitectureBaseline(
  projectRoot: string,
  _profile: CapabilityProfileV1,
  capturedAt = new Date().toISOString(),
): ArchitectureBaselineV1 {
  const head = gitHead(projectRoot);
  if (head) return { kind: 'git-head', identity: `git:${head}`, capturedAt };
  // A non-Git baseline covers the project, not only the currently detected
  // source roots. Otherwise an agent could create a new root before contract
  // compilation and have it silently treated as pre-existing debt.
  const baseline = fileManifestBaseline(projectRoot, ['.']);
  return { ...baseline, capturedAt };
}

export function architectureRunSnapshotPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'capability-v1.json');
}

export function architectureRunBaselinePath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'baseline-v1.json');
}

export function readArchitectureRunSnapshot(
  projectRoot: string,
  runId: string,
): ArchitectureRunSnapshotV1 | null {
  const raw = readJson<ArchitectureRunSnapshotV1 | null>(
    architectureRunSnapshotPath(projectRoot, runId),
    null,
  );
  if (!raw
    || raw.schemaVersion !== ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION
    || raw.runId !== runId) return null;
  const { snapshotHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}

export function readArchitectureRunBaseline(
  projectRoot: string,
  runId: string,
): ArchitectureRunBaselineV1 | null {
  const raw = readJson<ArchitectureRunBaselineV1 | null>(
    architectureRunBaselinePath(projectRoot, runId),
    null,
  );
  if (!raw
    || raw.schemaVersion !== ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION
    || raw.runId !== runId) return null;
  const { baselineHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}
