// src/runners/gitnexus/bootstrap.ts
// Foreground GitNexus bootstrap. Mirror of the graphify runner — same return
// shape, same opt-out semantics — used by the post-build code-graph hint and
// the orchestrator's Phase 5 when `state.codeGraphProvider === 'gitnexus'`.
// Ported 1:1 from scripts/gitnexus-runner/{_helpers,bootstrap}.cjs.
//
// LICENSE NOTICE: GitNexus is PolyForm Noncommercial-licensed. This runner only
// fires when the user explicitly picked `codeGraphProvider: "gitnexus"` during
// onboarding — that choice is the consent record. The runner emits a license
// reminder in its return payload so the calling hook can surface it.

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { exec } from '../../shared/exec';
import { writeGraphPreview } from '../../shared/materialize';
import { readEffectiveState, mergeProjectPrefs } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { mergeToolchainStamp, probeToolVersion } from '../toolchain';
import {
  GITNEXUS_MIN_NODE_MAJOR,
  currentNodeMajor,
  findNvmNode22,
  nodeVersionMismatchMessage,
  nvmInstallCommand,
  nvmPresent,
} from './nvm';

type Rec = Record<string, unknown>;
const which = exec.which;

export const GITNEXUS_DIR = '.gitnexus';
export const REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFLICT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/skills'];

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
  recommendedCommand?: string;
}

export interface BootstrapOpts {
  force?: boolean;
  skipInstall?: boolean;
  nodeMajor?: number;
}

function runStampForFs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

function readState(cwd: string): Rec {
  return readEffectiveState(cwd);
}

function writeStateMerge(cwd: string, patch: Rec): void {
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
  return crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex');
}

function copyRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.copyFileSync(src, dst);
  }
}

interface BackupRecord { rel: string; sha: string | null; }
interface Backups { backupRoot: string; recorded: BackupRecord[]; }

function backupConflicts(cwd: string, runStamp: string): Backups {
  const backupRoot = path.join(cwd, '.traffic-one', 'backups', runStamp);
  const recorded: BackupRecord[] = [];
  for (const rel of CONFLICT_PATHS) {
    const src = path.join(cwd, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(backupRoot, rel);
    try {
      copyRecursive(src, dst);
      recorded.push({ rel, sha: sha1OfPath(src) });
    } catch {
      // best-effort; absence of backup is non-fatal
    }
  }
  return { backupRoot, recorded };
}

function restoreIfOverwritten(cwd: string, backups: Backups): string[] {
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

interface InstallResult {
  action: string;
  error: string | null;
  gitnexusBin?: string | null;
  fallback?: string;
}

function tryInstall(): InstallResult {
  // Prefer the absolute nvm-v22 npm when available so the install lands in the
  // v22 nvm folder regardless of which Node is "active" in PATH. This matters
  // when Claude Code's hook shell was snapshotted before the user bumped their
  // nvm default to 22 — `npm` on PATH would still point at Node 20, and
  // installing gitnexus there places a broken binary that crashes with
  // `SyntaxError: Cannot use import statement` on every run.
  const nvm22 = findNvmNode22();
  let npmCmd: string;
  let installAction: string;
  if (nvm22 && nvm22.npm) {
    npmCmd = nvm22.npm;
    installAction = 'installed-nvm-v22';
  } else if (which('npm')) {
    npmCmd = 'npm';
    installAction = 'installed-npm-global';
  } else {
    return {
      action: 'install-skipped',
      error: '`npm` not on PATH and no `~/.nvm/versions/node/v22.*` install detected. Install Node.js >=22 (`nvm install 22 && nvm alias default 22`) or pick `graphify` as the codeGraphProvider.',
    };
  }
  const result = spawnSync(npmCmd, ['install', '-g', 'gitnexus'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180 * 1000,
  });
  // Post-install: prefer the absolute v22 gitnexus path; fall back to PATH.
  const installedAbs = nvm22 && fs.existsSync(path.join(nvm22.root, 'bin', 'gitnexus'))
    ? path.join(nvm22.root, 'bin', 'gitnexus')
    : null;
  if (result.status === 0 && (installedAbs || which('gitnexus'))) {
    return { action: installAction, error: null, gitnexusBin: installedAbs };
  }
  const stderr = (result.stderr || '').trim();
  if (/EACCES|permission denied|EPERM/i.test(stderr)) {
    return {
      action: 'install-skipped',
      error: 'npm global install failed (EACCES). Try `sudo npm install -g gitnexus` or set npm prefix to a user-writable path. As an alternative, the runner can use `npx gitnexus@latest` on each run — slower but no global install needed.',
      fallback: 'npx',
    };
  }
  return {
    action: 'install-skipped',
    error: `npm install -g gitnexus failed: ${stderr || 'non-zero exit'}`,
  };
}

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
  skippedGit: boolean;
  binUsed: string;
}

function runGitnexus(cwd: string, opts: { useNpx?: boolean; gitnexusBin?: string | null }): RunResult {
  // Pick the gitnexus binary in priority order: explicit opts.gitnexusBin (just
  // installed) → absolute nvm-v22 gitnexus (PATH-independent) → npx fallback →
  // bare `gitnexus` from PATH.
  let cmd: string;
  let baseArgs = ['analyze', '.'];
  const nvm22 = findNvmNode22();
  if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin)) {
    cmd = opts.gitnexusBin;
  } else if (opts.useNpx) {
    cmd = 'npx';
    baseArgs = ['gitnexus@latest', ...baseArgs];
  } else if (nvm22 && nvm22.gitnexus) {
    cmd = nvm22.gitnexus;
  } else {
    cmd = 'gitnexus';
  }
  // Fresh scaffolds typically don't have `.git/` initialised yet. GitNexus
  // refuses non-git folders by default with a tip it writes to STDOUT (not
  // stderr), so a naïve runner would surface an opaque non-zero with empty
  // stderr. Pre-detect and pass `--skip-git` ourselves.
  const hasGit = fs.existsSync(path.join(cwd, '.git'));
  if (!hasGit) baseArgs.push('--skip-git');
  const result = spawnSync(cmd, baseArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stderr: (result.stderr || '').trim(),
    stdout: (result.stdout || '').trim(),
    skippedGit: !hasGit,
    binUsed: cmd,
  };
}

export function bootstrap(cwd: string = process.cwd(), opts: BootstrapOpts = {}): BootstrapResult {
  const startedAt = Date.now();
  const reportAbs = path.join(cwd, GITNEXUS_DIR);

  // Opt-out: provider-agnostic `codeGraphAutoRun: false`; the older
  // `graphifyAutoRun: false` is also honoured for forward compatibility.
  const state = readState(cwd);
  if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', report: null, error: 'codeGraphAutoRun is false in local Traffic One preferences', durationMs: 0 };
  }

  // Fresh-cache short-circuit.
  if (!opts.force && fs.existsSync(reportAbs)) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(reportAbs).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs > 0 && (Date.now() - mtimeMs) < REPORT_FRESH_MS) {
      return { ok: true, action: 'fresh', report: reportAbs, error: null, durationMs: 0, license: 'PolyForm Noncommercial' };
    }
  }

  const nvm22 = findNvmNode22();
  const hasGitnexusOnPath = which('gitnexus') !== null;
  const hasAbsoluteGitnexus = !!(nvm22 && nvm22.gitnexus);
  const major = typeof opts.nodeMajor === 'number' ? opts.nodeMajor : currentNodeMajor();
  const canInstallOnV22 = !!(nvm22 && nvm22.npm);

  // Refuse early only if there's no path forward: no v22 nvm install AND no
  // gitnexus on PATH AND current Node is too old to install gitnexus.
  if (
    !hasAbsoluteGitnexus
    && !hasGitnexusOnPath
    && !canInstallOnV22
    && major !== null
    && major < GITNEXUS_MIN_NODE_MAJOR
  ) {
    if (nvmPresent()) {
      const command = nvmInstallCommand();
      const error = (
        `GitNexus needs Node >=${GITNEXUS_MIN_NODE_MAJOR}. `
        + `nvm is installed but has no v${GITNEXUS_MIN_NODE_MAJOR} version yet.\n`
        + 'One bash command sets it all up (install + default + gitnexus). '
        + 'Run it via the Bash tool — the user\'s permission prompt is the consent gate:\n\n'
        + `  ${command}\n\n`
        + 'After it succeeds, re-invoke the runner (or wait for the next post-build hook).'
      );
      writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: error });
      return {
        ok: false,
        action: 'nvm-install-needed',
        report: null,
        error,
        durationMs: Date.now() - startedAt,
        license: 'PolyForm Noncommercial',
        nodeMajor: major,
        requiredNodeMajor: GITNEXUS_MIN_NODE_MAJOR,
        recommendedCommand: command,
      };
    }

    const error = nodeVersionMismatchMessage(major);
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: error });
    return {
      ok: false,
      action: 'node-version-mismatch',
      report: null,
      error,
      durationMs: Date.now() - startedAt,
      license: 'PolyForm Noncommercial',
      nodeMajor: major,
      requiredNodeMajor: GITNEXUS_MIN_NODE_MAJOR,
    };
  }

  if (
    !hasAbsoluteGitnexus
    && !hasGitnexusOnPath
    && !canInstallOnV22
    && !which('npm')
    && nvmPresent()
  ) {
    const command = nvmInstallCommand();
    const error = (
      `GitNexus needs Node >=${GITNEXUS_MIN_NODE_MAJOR}. `
      + `nvm is installed but has no v${GITNEXUS_MIN_NODE_MAJOR} version yet.\n`
      + 'One bash command sets it all up (install + default + gitnexus). '
      + 'Run it via the Bash tool — the user\'s permission prompt is the consent gate:\n\n'
      + `  ${command}\n\n`
      + 'After it succeeds, re-invoke the runner (or wait for the next post-build hook).'
    );
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: error });
    return {
      ok: false,
      action: 'nvm-install-needed',
      report: null,
      error,
      durationMs: Date.now() - startedAt,
      license: 'PolyForm Noncommercial',
      nodeMajor: major,
      requiredNodeMajor: GITNEXUS_MIN_NODE_MAJOR,
      recommendedCommand: command,
    };
  }

  let action = 'used-existing';
  let useNpx = false;
  let gitnexusBin: string | null = hasAbsoluteGitnexus && nvm22 ? nvm22.gitnexus : null;
  if (!hasAbsoluteGitnexus && !hasGitnexusOnPath) {
    if (opts.skipInstall) {
      return { ok: false, action: 'install-skipped', report: null, error: 'gitnexus not on PATH and skipInstall=true', durationMs: 0 };
    }
    const installResult = tryInstall();
    action = installResult.action;
    if (installResult.gitnexusBin) gitnexusBin = installResult.gitnexusBin;
    if (installResult.fallback === 'npx' && which('npx')) {
      // Use `npx gitnexus@latest analyze .` for this run; future runs continue
      // to use npx until the user fixes their npm prefix.
      useNpx = true;
      action = 'installed-npx-fallback';
    } else if (installResult.error || (!gitnexusBin && !which('gitnexus'))) {
      writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: installResult.error || 'gitnexus still not on PATH after install attempt' });
      return { ok: false, action, report: null, error: installResult.error || 'gitnexus not available after install', durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial' };
    }
  }

  // Conflict mitigation: GitNexus auto-writes AGENTS.md / CLAUDE.md /
  // .claude/skills/ which overlap traffic-one's own. Back up first.
  const runStamp = runStampForFs();
  const backups = backupConflicts(cwd, runStamp);

  const run = runGitnexus(cwd, { useNpx, gitnexusBin });
  if (run.status !== 0) {
    // GitNexus writes diagnostic tips to STDOUT, not stderr; surface stdout
    // when stderr is empty so the agent has something actionable to relay.
    const detail = run.stderr || run.stdout || 'gitnexus exited non-zero';
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: detail });
    return { ok: false, action, report: null, error: detail, durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot };
  }

  // Restore traffic-one's versions of AGENTS.md / CLAUDE.md / .claude/skills
  // if GitNexus's run changed them.
  const restored = restoreIfOverwritten(cwd, backups);

  // Sanity-check that GitNexus actually produced its index.
  if (!fs.existsSync(reportAbs)) {
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: 'gitnexus ran but .gitnexus/ was not produced' });
    return { ok: false, action, report: null, error: 'gitnexus ran but .gitnexus/ was not produced', durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot, restored };
  }

  // Probe the just-run binary's `--version` and stamp local preferences →
  // `toolchain.gitnexus` so doctor + future runners can compare installed-vs-
  // recommended without re-probing.
  let installedVersion: string | null = null;
  let probedBin: string | null = null;
  try {
    const binCandidate = run.binUsed || (nvm22 && nvm22.gitnexus) || (which('gitnexus') || null);
    if (binCandidate && fs.existsSync(binCandidate.replace(/\s.*/, ''))) {
      probedBin = binCandidate;
      installedVersion = probeToolVersion('gitnexus', { binPath: binCandidate });
    } else if (binCandidate) {
      // npx case — `binCandidate` is "npx" with args appended; probe via PATH.
      installedVersion = probeToolVersion('gitnexus');
    }
    if (installedVersion) {
      const current = readState(cwd);
      const updated = mergeToolchainStamp(current, 'gitnexus', {
        version: installedVersion,
        binPath: probedBin || undefined,
        at: nowIso(),
      });
      writeStateMerge(cwd, { toolchain: updated.toolchain });
    }
  } catch {
    // best-effort; never fail the run because the version probe glitched.
  }

  writeStateMerge(cwd, { gitnexusLastRunAt: nowIso() });

  // Write the compact graph preview so subagent SessionStart hooks can inline
  // a ~500-token module listing instead of forcing a full Read.
  try {
    writeGraphPreview(cwd, 'gitnexus');
  } catch {
    // best-effort; never fail the run because preview write glitched.
  }

  return {
    ok: true,
    action,
    report: reportAbs,
    error: null,
    durationMs: Date.now() - startedAt,
    license: 'PolyForm Noncommercial',
    backupRoot: backups.backupRoot,
    restored,
    installedVersion,
  };
}
