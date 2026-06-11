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
import {
  getToolSpec,
  isToolUsable,
  managedNpmBin,
  managedNpmPrefix,
  mergeToolchainStamp,
  probeTool,
  probeToolVersion,
  toolStatus,
} from '../toolchain';
import { CONFLICT_PATHS, GITNEXUS_DIR, GITNEXUS_MIN_NODE_MAJOR, REPORT_FRESH_MS } from '../../config/gitnexus';
import { GITNEXUS_ROOT_DIRNAME, relocateProviderSkills, relocateUnderTrafficOne } from '../../shared/codegraph';
import {
  currentNodeMajor,
  findNvmNode22,
  nvmPresent,
} from './nvm';

type Rec = Record<string, unknown>;
const which = exec.which;

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

function gitnexusPackageSpec(): string {
  const spec = getToolSpec('gitnexus');
  return typeof spec?.recommended === 'string' && spec.recommended
    ? `gitnexus@${spec.recommended}`
    : 'gitnexus';
}

function probeGitnexusVersion(gitnexusBin: string, nodeBin?: string | null): string | null {
  if (nodeBin && fs.existsSync(nodeBin)) {
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

function stampToolchain(cwd: string, gitnexusBin: string, version?: string | null): void {
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

function npmForGitnexus(): { npmCmd: string; nodeBin?: string | null; action: string; error: string | null } {
  const nvm22 = findNvmNode22();
  if (nvm22 && nvm22.npm && nvm22.node) {
    return { npmCmd: nvm22.npm, nodeBin: nvm22.node, action: 'installed-managed-nvm-v22', error: null };
  }
  const major = currentNodeMajor();
  if (major !== null && major >= GITNEXUS_MIN_NODE_MAJOR && which('npm')) {
    return { npmCmd: 'npm', nodeBin: which('node'), action: 'installed-managed-npm', error: null };
  }
  const nvmInstall = installNode22WithNvm();
  if (nvmInstall.ok) {
    const installed = findNvmNode22();
    if (installed && installed.npm && installed.node) {
      return { npmCmd: installed.npm, nodeBin: installed.node, action: 'installed-managed-nvm-v22', error: null };
    }
  }
  return {
    npmCmd: '',
    nodeBin: null,
    action: 'install-skipped',
    error: nvmInstall.error || `GitNexus needs Node >=${GITNEXUS_MIN_NODE_MAJOR}, and no compatible npm is available for hook-owned install.`,
  };
}

function tryInstall(cwd: string): InstallResult {
  const npm = npmForGitnexus();
  if (npm.error || !npm.npmCmd) {
    return {
      action: 'install-skipped',
      error: npm.error || 'npm unavailable for GitNexus install',
    };
  }
  const prefix = managedNpmPrefix('gitnexus');
  const result = spawnSync(npm.npmCmd, ['install', '-g', '--prefix', prefix, gitnexusPackageSpec()], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180 * 1000,
  });
  const installedAbs = managedNpmBin('gitnexus', 'gitnexus');
  if (result.status === 0 && fs.existsSync(installedAbs)) {
    const installedVersion = probeGitnexusVersion(installedAbs, npm.nodeBin);
    stampToolchain(cwd, installedAbs, installedVersion);
    return { action: npm.action, error: null, gitnexusBin: installedAbs, nodeBin: npm.nodeBin, installedVersion };
  }
  const stderr = (result.stderr || '').trim();
  return {
    action: 'install-skipped',
    error: `managed npm install of gitnexus failed: ${stderr || 'non-zero exit'}`,
  };
}

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
  skippedGit: boolean;
  binUsed: string;
  nodeUsed?: string | null;
}

function runGitnexus(cwd: string, opts: { useNpx?: boolean; gitnexusBin?: string | null; nodeBin?: string | null }): RunResult {
  // Pick the gitnexus binary in priority order: explicit opts.gitnexusBin (just
  // installed) → absolute nvm-v22 gitnexus (PATH-independent) → npx fallback →
  // bare `gitnexus` from PATH.
  let cmd: string;
  let baseArgs = ['analyze', '.'];
  const nvm22 = findNvmNode22();
  let nodeUsed: string | null | undefined;
  if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin) && opts.nodeBin && fs.existsSync(opts.nodeBin)) {
    cmd = opts.nodeBin;
    baseArgs = [opts.gitnexusBin, ...baseArgs];
    nodeUsed = opts.nodeBin;
  } else if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin)) {
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
  const status = typeof result.status === 'number' ? result.status : 1;
  // GitNexus writes ./.gitnexus in the project root (no output-dir flag).
  // Relocate it under .traffic-one/ so the graph never pollutes the root.
  if (status === 0) relocateUnderTrafficOne(cwd, GITNEXUS_ROOT_DIRNAME, GITNEXUS_DIR);
  return {
    status,
    stderr: (result.stderr || '').trim(),
    stdout: (result.stdout || '').trim(),
    skippedGit: !hasGit,
    binUsed: cmd,
    nodeUsed,
  };
}

export function ensureGitnexusTool(cwd: string = process.cwd(), opts: BootstrapOpts = {}): GitnexusToolResult {
  const state = readState(cwd);
  if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', error: 'codeGraphAutoRun is false in local Traffic One preferences', gitnexusBin: null };
  }

  const nvm22 = findNvmNode22();
  const major = typeof opts.nodeMajor === 'number' ? opts.nodeMajor : currentNodeMajor();
  const managedBin = managedNpmBin('gitnexus', 'gitnexus');
  const candidates = [
    { binPath: fs.existsSync(managedBin) ? managedBin : null, action: 'used-managed', nodeBin: (nvm22 && nvm22.node) || (major !== null && major >= GITNEXUS_MIN_NODE_MAJOR ? which('node') : null) },
    { binPath: nvm22 && nvm22.gitnexus ? nvm22.gitnexus : null, action: 'used-nvm-v22', nodeBin: nvm22 && nvm22.node },
    { binPath: which('gitnexus'), action: 'used-existing', nodeBin: null },
  ];
  for (const candidate of candidates) {
    if (!candidate.binPath) continue;
    const version = candidate.nodeBin
      ? probeGitnexusVersion(candidate.binPath, candidate.nodeBin)
      : probeTool('gitnexus', candidate.binPath).version;
    const status = toolStatus('gitnexus', version);
    const usable = version ? isToolUsable(status.status) : false;
    if (usable) {
      stampToolchain(cwd, candidate.binPath, version);
      return { ok: true, action: candidate.action, error: null, gitnexusBin: candidate.binPath, nodeBin: candidate.nodeBin, installedVersion: version };
    }
  }

  if (opts.skipInstall) {
    return { ok: false, action: 'install-skipped', error: 'gitnexus is missing or below the minimum supported version and skipInstall=true', gitnexusBin: null };
  }

  const installResult = tryInstall(cwd);
  if (installResult.error || !installResult.gitnexusBin) {
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: installResult.error || 'gitnexus still not available after install attempt' });
    return { ok: false, action: installResult.action, error: installResult.error || 'gitnexus not available after install', gitnexusBin: null };
  }

  return {
    ok: true,
    action: installResult.action,
    error: null,
    gitnexusBin: installResult.gitnexusBin,
    nodeBin: installResult.nodeBin,
    installedVersion: installResult.installedVersion,
  };
}

// A gitnexus index built on a pre-scaffold/empty project records `stats.files: 0`.
// Treat that as stale so the next build / orchestrator Phase 5 reindexes the real
// code once it exists — otherwise the 7-day freshness window keeps the empty graph.
export function gitnexusGraphIsEmpty(cwd: string): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cwd, GITNEXUS_DIR, 'meta.json'), 'utf8')) as Rec;
    const stats = meta && typeof meta.stats === 'object' && meta.stats ? (meta.stats as Rec) : null;
    if (!stats) return false;
    const files = Number(stats.files);
    const nodes = Number(stats.nodes);
    return (Number.isFinite(files) && files === 0) || (Number.isFinite(nodes) && nodes === 0);
  } catch {
    return false; // no/unreadable meta → can't tell → don't force a rebuild
  }
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
    if (mtimeMs > 0 && (Date.now() - mtimeMs) < REPORT_FRESH_MS && !gitnexusGraphIsEmpty(cwd)) {
      return { ok: true, action: 'fresh', report: reportAbs, error: null, durationMs: 0, license: 'PolyForm Noncommercial' };
    }
  }

  let action = 'used-existing';
  const useNpx = false;
  const ensured = ensureGitnexusTool(cwd, opts);
  action = ensured.action;
  if (!ensured.ok || !ensured.gitnexusBin) {
    return {
      ok: false,
      action,
      report: null,
      error: ensured.error || 'gitnexus not available after install',
      durationMs: Date.now() - startedAt,
      license: 'PolyForm Noncommercial',
      nodeMajor: typeof opts.nodeMajor === 'number' ? opts.nodeMajor : currentNodeMajor(),
      requiredNodeMajor: GITNEXUS_MIN_NODE_MAJOR,
    };
  }

  // Conflict mitigation: GitNexus auto-writes AGENTS.md / CLAUDE.md /
  // .claude/skills/ which overlap traffic-one's own. Back up first.
  const runStamp = runStampForFs();
  const backups = backupConflicts(cwd, runStamp);

  const run = runGitnexus(cwd, { useNpx, gitnexusBin: ensured.gitnexusBin, nodeBin: ensured.nodeBin });
  if (run.status !== 0) {
    // GitNexus writes diagnostic tips to STDOUT, not stderr; surface stdout
    // when stderr is empty so the agent has something actionable to relay.
    const detail = run.stderr || run.stdout || 'gitnexus exited non-zero';
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: detail });
    return { ok: false, action, report: null, error: detail, durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot };
  }

  // Adopt the skills GitNexus generated under .claude/skills/ into Traffic One's
  // per-project skills (.traffic-one/skills/<name>/) BEFORE the restore below —
  // restore then cleanly reinstates whatever .claude/skills the project had.
  relocateProviderSkills(cwd);

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
    const binCandidate = ensured.gitnexusBin || run.binUsed || (which('gitnexus') || null);
    if (binCandidate && run.nodeUsed && fs.existsSync(binCandidate.replace(/\s.*/, ''))) {
      probedBin = binCandidate;
      installedVersion = probeGitnexusVersion(binCandidate, run.nodeUsed);
    } else if (binCandidate && fs.existsSync(binCandidate.replace(/\s.*/, ''))) {
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
