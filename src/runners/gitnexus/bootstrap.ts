// src/runners/gitnexus/bootstrap.ts
// Gitnexus bootstrap: install + run over the env helpers.

import * as fs from 'fs';
import * as path from 'path';
import { ensureManagedRuntime } from '../../shared/managed-runtime';
import { resolveNode } from '../../shared/runtime-resolve';
import { spawnTool } from '../../shared/spawn-tool';
import { writeGraphPreview } from '../../shared/materialize';
import { nowIso } from '../../shared/text';
import {
  isToolUsable,
  managedNpmBin,
  managedNpmConfigFlags,
  managedNpmPrefix,
  mergeToolchainStamp,
  probeTool,
  probeToolVersion,
  toolStatus,
} from '../toolchain';
import {  GITNEXUS_DIR, GITNEXUS_MIN_NODE_MAJOR, REPORT_FRESH_MS } from '../../config/gitnexus';
import { CODE_GRAPH_SCAN_EXCLUDES, GITNEXUS_ROOT_DIRNAME, applyCodeGraphScanIgnore, codeGraphIndexIsStale, gitnexusGraphIsEmpty, relocateProviderSkills, relocateUnderTrafficOne } from '../../shared/codegraph';
import {
  currentNodeMajor,
  findNvmNode22,
} from './nvm';

import {
  backupConflicts,
  gitnexusPackageSpec,
  npmForGitnexus,
  probeGitnexusVersion,
  readState,
  restoreIfOverwritten,
  runStampForFs,
  stampToolchain,
  which,
  writeStateMerge,
  type BootstrapOpts,
  type BootstrapResult,
  type GitnexusToolResult,
  type InstallResult,
} from './bootstrap-env';

function tryInstall(cwd: string): InstallResult {
  const npm = npmForGitnexus();
  if (npm.error || !npm.npmCmd) {
    return {
      action: 'install-skipped',
      error: npm.error || 'npm unavailable for GitNexus install',
    };
  }
  const prefix = managedNpmPrefix('gitnexus');
  // Route through spawnTool so a Windows npm.cmd shim is invoked correctly (Node
  // >=22 refuses a bare .cmd without it). Pin user+global config to managed
  // (absent → empty) files so a user `.npmrc prefix=` can't redirect the install
  // out of the managed dir — keeps the "never the user's global prefix" invariant.
  // managedNpmConfigFlags uses two DISTINCT paths: npm >= 11 rejects the same file
  // at both levels ("double-loading config ... as global, previously loaded as user").
  const result = spawnTool(npm.npmCmd, ['install', '-g', '--prefix', prefix, ...managedNpmConfigFlags(prefix), gitnexusPackageSpec()], {
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
  // --skip-agents-md: gitnexus would otherwise inject its "Code Intelligence"
  // block into root AGENTS.md/CLAUDE.md (creating them on a fresh project),
  // which Traffic One's materializer then preserves into .local notes — ~5 KB
  // of duplicated boilerplate in every generated AGENTS.md. Traffic One's own
  // kernel, codebase-graph rule, and session graph preview already carry that
  // guidance.
  let baseArgs = ['analyze', '.', '--skip-agents-md'];
  const nvm22 = findNvmNode22();
  let nodeUsed: string | null | undefined;
  // A Windows `.cmd` bin must NOT be run as `node <bin>` (node can't parse a batch
  // wrapper as JS) — run the .cmd directly so spawnTool routes it through cmd.exe.
  const batchBin = /\.(cmd|bat)$/i.test(opts.gitnexusBin || '');
  if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin) && opts.nodeBin && fs.existsSync(opts.nodeBin) && !batchBin) {
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
  // Keep Traffic One's own materialized docs out of the graph. gitnexus already
  // built-in-excludes .claude/.cursor/AGENTS.md/CLAUDE.md but NOT .traffic-one, and
  // has no `--exclude` flag — it honors a root `.gitnexusignore`, which we scope to
  // the scan and restore afterwards so the project root is never permanently changed.
  const restoreIgnore = applyCodeGraphScanIgnore(cwd, '.gitnexusignore', CODE_GRAPH_SCAN_EXCLUDES);
  // spawnTool: cmd may be `npx`/bare `gitnexus` (→ .cmd shims on Windows) or an
  // absolute node/managed bin (passes straight through).
  let result;
  try {
    result = spawnTool(cmd, baseArgs, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000,
    });
  } finally {
    restoreIgnore();
  }
  const status = typeof result.status === 'number' ? result.status : 1;
  // GitNexus writes ./.gitnexus in the project root (no output-dir flag).
  // Relocate it under .traffic-one/ so the graph never pollutes the root.
  if (status === 0) relocateUnderTrafficOne(cwd, GITNEXUS_ROOT_DIRNAME, GITNEXUS_DIR);
  // A non-zero exit can still leave a partial root .gitnexus/; sweep it so the
  // project root is never polluted (the good index stays under .traffic-one/).
  else { try { fs.rmSync(path.join(cwd, GITNEXUS_ROOT_DIRNAME), { recursive: true, force: true }); } catch { /* best-effort */ } }
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
  // Node to RUN an already-installed managed gitnexus: nvm-v22 → PATH node (if >=22)
  // → a resolved Homebrew/volta/fnm node → the managed node. Without the last two, a
  // machine whose only Node>=22 is the managed one couldn't reuse the managed gitnexus
  // on later sessions and would needlessly reinstall. Resolve the costlier fallbacks
  // ONLY when a managed gitnexus actually exists (else candidate (a) is skipped).
  let managedReuseNode: string | null = (nvm22 && nvm22.node) || (major !== null && major >= GITNEXUS_MIN_NODE_MAJOR ? which('node') : null);
  if (!managedReuseNode && fs.existsSync(managedBin)) {
    managedReuseNode = resolveNode(GITNEXUS_MIN_NODE_MAJOR)?.path ?? null;
    if (!managedReuseNode) {
      const mn = ensureManagedRuntime('node', { minMajor: GITNEXUS_MIN_NODE_MAJOR });
      if (mn.ok && mn.path) managedReuseNode = mn.path;
    }
  }
  const candidates = [
    { binPath: fs.existsSync(managedBin) ? managedBin : null, action: 'used-managed', nodeBin: managedReuseNode },
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

// gitnexusGraphIsEmpty now lives in shared/codegraph (so runner-free consumers
// can use it too); re-export it here to preserve the runner's public surface.
export { gitnexusGraphIsEmpty };

export function bootstrap(cwd: string = process.cwd(), opts: BootstrapOpts = {}): BootstrapResult {
  const startedAt = Date.now();
  const reportAbs = path.join(cwd, GITNEXUS_DIR);

  // Opt-out: provider-agnostic `codeGraphAutoRun: false`; the older
  // `graphifyAutoRun: false` is also honoured for forward compatibility.
  const state = readState(cwd);
  if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', report: null, error: 'codeGraphAutoRun is false in local Traffic One preferences', durationMs: 0 };
  }

  // Fresh-cache short-circuit. "Fresh" = within 7 days AND non-empty (the 0-file
  // onboarding scan predates the code) AND not stale vs source (no project file
  // newer than the index — catches fix-cycle/ad-hoc edits and a dropped --force).
  // Any failing rebuilds even without --force, so refresh self-heals on every host.
  if (!opts.force && fs.existsSync(reportAbs)) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(reportAbs).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs > 0 && (Date.now() - mtimeMs) < REPORT_FRESH_MS && !gitnexusGraphIsEmpty(cwd) && !codeGraphIndexIsStale(cwd, mtimeMs)) {
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
export {
  gitnexusPackageSpec,
  type BootstrapOpts,
  type BootstrapResult,
  type GitnexusToolResult,
} from './bootstrap-env';
