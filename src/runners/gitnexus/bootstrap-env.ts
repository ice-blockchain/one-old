// src/runners/gitnexus/bootstrap-env.ts
// Bootstrap environment: state stamps, node resolution, and install.

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { copyTreeStrict } from '../../shared/copy-tree';
import { exec } from '../../shared/exec';
import { ensureManagedRuntime } from '../../shared/managed-runtime';
import { pruneTrafficOneBackups } from '../../shared/retention';
import { resolveNode, npmNextToNode } from '../../shared/runtime-resolve';
import { spawnTool } from '../../shared/spawn-tool';
import { readEffectiveState, mergeProjectPrefs } from '../../shared/state';
import { nowIso } from '../../shared/text';
import {
  getToolSpec,
  mergeToolchainStamp,
  probeToolVersion,
  toolInstallSpec,
} from '../toolchain';
import { CONFLICT_PATHS,  GITNEXUS_MIN_NODE_MAJOR } from '../../config/gitnexus';
import {
  currentNodeMajor,
  findNvmNode22,
  nvmPresent,
} from './nvm';
import { copyRegularFile, readRegularBytesOrThrow } from '../../shared/bounded-read';

type Rec = Record<string, unknown>;

export const which = exec.which;

export interface BootstrapResult {
  ok: boolean;
  action: string;
  report: string | null;
  error: string | null;
  durationMs: number;
  license?: string;
  backupRoot?: string;
  restored?: string[];
  installedVersion?: string | null;
  nodeMajor?: number | null;
  requiredNodeMajor?: number;
}

export interface BootstrapOpts {
  force?: boolean;
  skipInstall?: boolean;
  nodeMajor?: number;
}

export function runStampForFs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

export function readState(cwd: string): Rec {
  return readEffectiveState(cwd);
}

export function writeStateMerge(cwd: string, patch: Rec): void {
  try {
    mergeProjectPrefs(cwd, patch);
  } catch {
    // best-effort; the runner never throws
  }
}

function sha1OfPath(absPath: string): string | null {
  if (!fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    // Hash the recursive listing (paths + sizes); good enough to detect changes.
    const hash = crypto.createHash('sha1');
    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          hash.update(`d:${path.relative(absPath, full)}\n`);
          walk(full);
        } else if (entry.isFile()) {
          const s = fs.statSync(full);
          hash.update(`f:${path.relative(absPath, full)}:${s.size}\n`);
        }
      }
    };
    walk(absPath);
    return hash.digest('hex');
  }
  return crypto.createHash('sha1').update(readRegularBytesOrThrow(absPath)).digest('hex');
}

// `CLAUDE.md` is a symlink to `AGENTS.md` in most Traffic One projects, and both
// copyFileSync and cpSync DEREFERENCE it — so every snapshot stored two full
// copies of the same 8703-byte file (observed live). Recreate the link instead
// whenever it points at a sibling INSIDE the copied set; an absolute or
// escaping target is still dereferenced, because a backup whose link leaves the
// backup restores nothing.
function copyRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let link: string | null = null;
  try {
    if (fs.lstatSync(src).isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      if (!path.isAbsolute(target) && !target.split(/[\\/]/).includes('..')) link = target;
    }
  } catch {
    // not a link, or unreadable — fall through to a content copy
  }
  if (link) {
    try {
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* nothing to clear */ }
      fs.symlinkSync(link, dst);
      return;
    } catch {
      // Windows without the symlink privilege — fall through to a content copy
    }
  }
  if (fs.statSync(src).isDirectory()) {
    // `fs.cpSync` SILENTLY OMITS a FIFO or a socket inside the tree (measured on
    // node v26.5.0: returns in ~2 ms, destination missing the entry) and ABORTS
    // THE PROCESS on a symlink loop — exit 134, past both `try/catch` and
    // `uncaughtException`, which the `catch { /* best-effort */ }` in
    // `backupConflicts` cannot see. `.claude/skills` is one of CONFLICT_PATHS, so
    // this is the ORDINARY path of the gitnexus backup and not an exotic one, and
    // `recorded.push` runs immediately after it.
    copyTreeStrict(src, dst);
  } else {
    // The managed binary: `copyRegularFile` carries the source's mode across, so
    // the executable bit survives a copy that `open(dst, 'w')` would have created
    // 0o644. THE ANSWER IS RAISED, not discarded: this function is the BACKUP
    // WRITER, and `backupConflicts` pushes `{ rel, sha }` unconditionally after
    // it returns — the same phantom shape `git-sandbox.ts` was fixed for. What
    // saved it from the same cost was luck (`restoreIfOverwritten` only `rmSync`s
    // a live path that is a DIRECTORY, so a phantom file backup restored nothing
    // rather than destroying something), and luck is not the rule
    // `copyRegularFile`'s docblock states.
    if (!copyRegularFile(src, dst)) {
      throw new Error(`cannot back up ${src}: not a regular file — refusing to record a backup that is not there`);
    }
  }
}

interface BackupRecord { rel: string; sha: string | null; }
interface Backups { backupRoot: string; recorded: BackupRecord[]; }

function backupStamps(cwd: string): string[] {
  try {
    return fs.readdirSync(path.join(cwd, '.traffic-one', 'backups'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return []; // no backups dir yet
  }
}

/** True when `backupRoot` already holds byte-identical content for every live path. */
function snapshotMatchesLive(backupRoot: string, live: readonly BackupRecord[]): boolean {
  if (live.length === 0) return false;
  return live.every(({ rel, sha }) => Boolean(sha) && sha1OfPath(path.join(backupRoot, rel)) === sha);
}

export function backupConflicts(cwd: string, runStamp: string): Backups {
  // Hash what is on disk right now, once.
  const live: BackupRecord[] = [];
  for (const rel of CONFLICT_PATHS) {
    const src = path.join(cwd, rel);
    if (!fs.existsSync(src)) continue;
    // `sha1OfPath` REFUSES a non-regular file (`readRegularBytesOrThrow`), and this
    // loop used to let that throw escape: `bootstrap.ts:266` calls
    // `backupConflicts` unguarded, so `AGENTS.md -> /dev/zero` — mode 120000, so
    // clone-deliverable through an ordinary pull request — turned the whole
    // gitnexus bootstrap into a thrown error instead of a skipped backup.
    // DRIVEN before the change: `Error: <tmp>/AGENTS.md cannot be read
    // (not-a-regular-file)` out of `backupConflicts`, with nothing recorded.
    // `sha: null` is the right answer and already means all the right things
    // downstream: `snapshotMatchesLive` requires `Boolean(sha)`, so no reuse; and
    // `restoreIfOverwritten` requires both shas, so no restore. It also means the
    // backup WRITER is now reached for such a path, which is what makes its
    // refusal load-bearing rather than decorative.
    let sha: string | null = null;
    try { sha = sha1OfPath(src); } catch { sha = null; }
    live.push({ rel, sha });
  }
  // Skip the snapshot entirely when the newest one already holds exactly this
  // content. Bootstrap runs many times per session and each run re-snapshotted
  // the same unchanged files: four AGENTS.md/CLAUDE.md snapshots in four
  // minutes, ALL hashing identically to the live file — and rotation (keep 3)
  // then evicted the only snapshot that could have differed (observed live).
  // Restore stays correct because the reused root holds the same bytes.
  const stamps = backupStamps(cwd);
  const newest = stamps.length > 0 ? stamps[stamps.length - 1]! : null;
  if (newest && newest !== runStamp) {
    const newestRoot = path.join(cwd, '.traffic-one', 'backups', newest);
    if (snapshotMatchesLive(newestRoot, live)) return { backupRoot: newestRoot, recorded: live };
  }
  const backupRoot = path.join(cwd, '.traffic-one', 'backups', runStamp);
  const recorded: BackupRecord[] = [];
  for (const { rel, sha } of live) {
    try {
      copyRecursive(path.join(cwd, rel), path.join(backupRoot, rel));
      recorded.push({ rel, sha });
    } catch {
      // best-effort; absence of backup is non-fatal
    }
  }
  // Cap the directory here, not only at SessionStart.
  try { pruneTrafficOneBackups(cwd, runStamp); } catch { /* best-effort */ }
  return { backupRoot, recorded };
}

export function restoreIfOverwritten(cwd: string, backups: Backups): string[] {
  const restored: string[] = [];
  for (const { rel, sha } of backups.recorded) {
    const livePath = path.join(cwd, rel);
    const liveSha = sha1OfPath(livePath);
    if (liveSha && sha && liveSha !== sha) {
      const backupPath = path.join(backups.backupRoot, rel);
      try {
        if (fs.existsSync(livePath)) {
          if (fs.statSync(livePath).isDirectory()) {
            fs.rmSync(livePath, { recursive: true, force: true });
          }
        }
        copyRecursive(backupPath, livePath);
        restored.push(rel);
      } catch {
        // best-effort
      }
    }
  }
  return restored;
}

export interface InstallResult {
  action: string;
  error: string | null;
  gitnexusBin?: string | null;
  nodeBin?: string | null;
  installedVersion?: string | null;
}

export interface GitnexusToolResult {
  ok: boolean;
  action: string;
  error: string | null;
  gitnexusBin: string | null;
  nodeBin?: string | null;
  installedVersion?: string | null;
}

export function gitnexusPackageSpec(): string {
  // Install LATEST by default (toolchain-versions.json: installLatest + npmPackage
  // → "gitnexus@latest"). A stale `recommended` pin must not doom an install; the
  // probed version is what we stamp afterwards.
  return toolInstallSpec('gitnexus') || 'gitnexus';
}

export function probeGitnexusVersion(gitnexusBin: string, nodeBin?: string | null): string | null {
  // `node <bin>` only works when <bin> is a node-runnable JS shim (the POSIX npm
  // layout). On Windows the managed/nvm/PATH bin is a `.cmd` BATCH wrapper that
  // node.exe cannot parse as JS — so for a .cmd/.bat bin, fall through to
  // probeToolVersion, which runs it through spawnTool (cmd.exe). It self-locates node.
  const isBatchBin = /\.(cmd|bat)$/i.test(gitnexusBin);
  if (nodeBin && fs.existsSync(nodeBin) && !isBatchBin) {
    try {
      const result = spawnSync(nodeBin, [gitnexusBin, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10 * 1000,
      });
      const blob = `${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`;
      const regex = new RegExp(getToolSpec('gitnexus')?.versionRegex || 'v?(\\d+\\.\\d+\\.\\d+)');
      const match = regex.exec(blob);
      return match && match[1] ? match[1] : null;
    } catch {
      return null;
    }
  }
  return probeToolVersion('gitnexus', { binPath: gitnexusBin });
}

export function stampToolchain(cwd: string, gitnexusBin: string, version?: string | null): void {
  if (!version) return;
  const current = readState(cwd);
  const updated = mergeToolchainStamp(current, 'gitnexus', {
    version,
    binPath: gitnexusBin,
    at: nowIso(),
  });
  writeStateMerge(cwd, { toolchain: updated.toolchain });
}

function installNode22WithNvm(): { ok: boolean; error: string | null } {
  if (!nvmPresent()) return { ok: false, error: 'nvm is not installed, so the hook cannot prepare Node 22 for GitNexus automatically' };
  const result = spawnSync('bash', ['-lc', `. "$HOME/.nvm/nvm.sh" && nvm install ${GITNEXUS_MIN_NODE_MAJOR}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });
  if (result.status === 0) return { ok: true, error: null };
  return { ok: false, error: `nvm install ${GITNEXUS_MIN_NODE_MAJOR} failed: ${(result.stderr || result.stdout || '').trim() || 'non-zero exit'}` };
}

export function npmForGitnexus(): { npmCmd: string; nodeBin?: string | null; action: string; error: string | null } {
  const nvm22 = findNvmNode22();
  if (nvm22 && nvm22.npm && nvm22.node) {
    return { npmCmd: nvm22.npm, nodeBin: nvm22.node, action: 'installed-managed-nvm-v22', error: null };
  }
  const major = currentNodeMajor();
  if (major !== null && major >= GITNEXUS_MIN_NODE_MAJOR && which('npm')) {
    return { npmCmd: 'npm', nodeBin: which('node'), action: 'installed-managed-npm', error: null };
  }
  // A Homebrew/volta/fnm (or any PATH-absolute) Node >=22 that is neither an nvm v22
  // nor the hook's own runtime: install through the npm beside it BEFORE paying for
  // `nvm install 22` or a managed download (mirrors opencode's resolveNode ladder).
  const resolved = resolveNode(GITNEXUS_MIN_NODE_MAJOR);
  if (resolved) {
    const resolvedNpm = npmNextToNode(resolved.path);
    if (resolvedNpm) {
      return { npmCmd: resolvedNpm, nodeBin: resolved.path, action: 'installed-managed-npm', error: null };
    }
  }
  const nvmInstall = installNode22WithNvm();
  if (nvmInstall.ok) {
    const installed = findNvmNode22();
    if (installed && installed.npm && installed.node) {
      return { npmCmd: installed.npm, nodeBin: installed.node, action: 'installed-managed-nvm-v22', error: null };
    }
  }
  // Last resort: a Traffic One-managed standalone Node (downloaded into an
  // isolated dir, npm bundled in its bin/) — for machines with no nvm/PATH/brew
  // Node >=22 at all. Never on PATH, never the system node.
  const managed = ensureManagedRuntime('node', { minMajor: GITNEXUS_MIN_NODE_MAJOR });
  if (managed.ok && managed.binDir) {
    const npm = path.join(managed.binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (fs.existsSync(npm)) {
      return { npmCmd: npm, nodeBin: managed.path, action: 'installed-managed-runtime-node', error: null };
    }
  }
  return {
    npmCmd: '',
    nodeBin: null,
    action: 'install-skipped',
    error: nvmInstall.error || `GitNexus needs Node >=${GITNEXUS_MIN_NODE_MAJOR}, and no compatible npm is available for hook-owned install.`,
  };
}

