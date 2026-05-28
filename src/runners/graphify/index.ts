// src/runners/graphify/index.ts
// Foreground graphify bootstrap (compiles to scripts/graphify-runner.cjs).
// Called synchronously by the post-build code-graph hint so a fresh
// `mode: new-project` scaffold ends up with `graphify-out/GRAPH_REPORT.md`
// after the first successful build. Ported 1:1 from scripts/graphify-runner.cjs.
//
// Output shape:
//   { ok, action: 'used-existing'|'fresh'|'installed-pipx'|'installed-pip'|
//     'install-skipped', report: '<abs>'|null, error: '<msg>'|null,
//     durationMs, installedVersion? }

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { exec } from '../../shared/exec';
import { writeGraphPreview } from '../../shared/materialize';
import { mergeProjectPrefs, readEffectiveState } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { mergeToolchainStamp, probeToolVersion } from '../toolchain';

type Rec = Record<string, unknown>;
const which = exec.which;

const REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface GraphifyResult {
  ok: boolean;
  action: string;
  report: string | null;
  error: string | null;
  durationMs: number;
  installedVersion?: string | null;
}

export interface GraphifyOpts {
  force?: boolean;
  skipInstall?: boolean;
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

interface InstallResult { action: string; error: string | null; }

function tryInstall(): InstallResult {
  // Path A: pipx (recommended for end-users).
  if (which('pipx')) {
    const result = spawnSync('pipx', ['install', 'graphifyy', '--quiet'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90 * 1000,
    });
    if (result.status === 0 && which('graphify')) {
      return { action: 'installed-pipx', error: null };
    }
    return {
      action: 'install-skipped',
      error: `pipx install graphifyy failed: ${(result.stderr || '').trim() || 'non-zero exit'}`,
    };
  }

  // Path B: python3 -m pip --user.
  if (which('python3')) {
    const result = spawnSync('python3', ['-m', 'pip', 'install', '--user', 'graphifyy', '--quiet'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90 * 1000,
    });
    if (result.status === 0 && which('graphify')) {
      return { action: 'installed-pip', error: null };
    }
    return {
      action: 'install-skipped',
      error: `pip install --user graphifyy failed: ${(result.stderr || '').trim() || 'non-zero exit'}`,
    };
  }

  return {
    action: 'install-skipped',
    error: 'Neither `pipx` nor `python3` is on PATH. Install graphify manually: `pipx install graphifyy`.',
  };
}

function runGraphify(cwd: string): { status: number; stderr: string; stdout: string } {
  // graphify's CLI requires a subcommand. `update <path>` (re-)extracts code
  // files and writes graphify-out/{GRAPH_REPORT.md, graph.json, graph.html}.
  // Works on a fresh directory too — no separate init step.
  const result = spawnSync('graphify', ['update', '.'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stderr: (result.stderr || '').trim(),
    stdout: (result.stdout || '').trim(),
  };
}

export function bootstrap(cwd: string = process.cwd(), opts: GraphifyOpts = {}): GraphifyResult {
  const startedAt = Date.now();
  const reportRel = path.join('graphify-out', 'GRAPH_REPORT.md');
  const reportAbs = path.join(cwd, reportRel);

  // Opt-out: `graphifyAutoRun: false` in local preferences disables foreground
  // bootstrap. Today the default is unset (run).
  const state = readState(cwd);
  if (state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', report: null, error: 'graphifyAutoRun is false in local Traffic One preferences', durationMs: 0 };
  }

  // Fresh-report short-circuit. Lets the orchestrator's Phase 5 invoke the
  // runner unconditionally without paying install/scan cost on every run.
  if (!opts.force && fs.existsSync(reportAbs)) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(reportAbs).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs > 0 && (Date.now() - mtimeMs) < REPORT_FRESH_MS) {
      return { ok: true, action: 'fresh', report: reportAbs, error: null, durationMs: 0 };
    }
  }

  let action = 'used-existing';
  if (!which('graphify')) {
    if (opts.skipInstall) {
      return { ok: false, action: 'install-skipped', report: null, error: 'graphify not on PATH and skipInstall=true', durationMs: 0 };
    }
    const installResult = tryInstall();
    action = installResult.action;
    if (installResult.error || !which('graphify')) {
      writeStateMerge(cwd, { graphifyLastErrorAt: nowIso(), graphifyLastError: installResult.error || 'graphify still not on PATH after install attempt' });
      return { ok: false, action, report: null, error: installResult.error || 'graphify not available after install', durationMs: Date.now() - startedAt };
    }
  }

  const run = runGraphify(cwd);
  if (run.status !== 0) {
    writeStateMerge(cwd, { graphifyLastErrorAt: nowIso(), graphifyLastError: run.stderr || 'graphify exited non-zero' });
    return { ok: false, action, report: null, error: run.stderr || 'graphify exited non-zero', durationMs: Date.now() - startedAt };
  }

  // Sanity-check that the report actually landed.
  if (!fs.existsSync(reportAbs)) {
    writeStateMerge(cwd, { graphifyLastErrorAt: nowIso(), graphifyLastError: 'graphify ran but GRAPH_REPORT.md was not produced' });
    return { ok: false, action, report: null, error: 'graphify ran but GRAPH_REPORT.md was not produced', durationMs: Date.now() - startedAt };
  }

  // Probe `graphify --version` and stamp local preferences → `toolchain.graphify`
  // so doctor + post-build hooks can compare installed vs recommended.
  let installedVersion: string | null = null;
  try {
    installedVersion = probeToolVersion('graphify');
    if (installedVersion) {
      const current = readState(cwd);
      const updated = mergeToolchainStamp(current, 'graphify', { version: installedVersion, at: nowIso() });
      writeStateMerge(cwd, { toolchain: updated.toolchain });
    }
  } catch {
    // best-effort; never fail the run because the version probe glitched.
  }

  writeStateMerge(cwd, { graphifyLastRunAt: nowIso() });

  // Write the compact graph preview so subagent SessionStart hooks can inline
  // a ~500-token module listing instead of forcing a full Read of GRAPH_REPORT.md.
  try {
    writeGraphPreview(cwd, 'graphify');
  } catch {
    // best-effort; never fail the run because preview write glitched.
  }

  return { ok: true, action, report: reportAbs, error: null, durationMs: Date.now() - startedAt, installedVersion };
}

export { nowIso };
export { which };

// CLI entry: runs the bootstrap from cwd and prints a one-line JSON summary.
// Exit code is 0 on success AND on graceful skip — the caller is the post-build
// hint, which should never block the user's flow on a non-zero exit.
export function main(): void {
  const result = bootstrap(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

if (require.main === module) main();
