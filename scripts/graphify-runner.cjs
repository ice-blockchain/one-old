#!/usr/bin/env node
'use strict';

// scripts/graphify-runner.cjs
// Foreground graphify bootstrap. Called synchronously by the post-build hook
// (handlers.cjs `runPostBuildGraphifyHint`) so a fresh `mode: new-project`
// scaffold ends up with `graphify-out/GRAPH_REPORT.md` after the first
// successful build, without the agent or the user having to remember.
//
// Behaviour summary:
//   1. Probe `graphify` on PATH. If found, jump to step 4.
//   2. Probe `pipx`. If found, `pipx install graphifyy --quiet`.
//   3. Else probe `python3 -m pip`. If found, `python3 -m pip install --user graphifyy --quiet`.
//   4. Run `graphify . --no-viz --code-only --quiet` synchronously.
//   5. Stamp `.traffic-one.json` with `graphifyLastRunAt` (success) or
//      `graphifyLastErrorAt` + `graphifyLastError` (failure). Caller decides
//      what to do with the result; this runner never throws.
//
// Output shape:
//   { ok: boolean, action: 'used-existing'|'installed-pipx'|'installed-pip'|'install-skipped',
//     report: '<absolute-path>'|null, error: '<message>'|null, durationMs: number }

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getPluginVersion } = require('./hook-runtime/state/state.cjs');

const TRAFFIC_ONE = '.traffic-one.json';

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function which(cmd) {
  const result = spawnSync('command', ['-v', cmd], { encoding: 'utf8', shell: true });
  if (result.status === 0 && typeof result.stdout === 'string') {
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  }
  return null;
}

function readState(cwd) {
  const filePath = path.join(cwd, TRAFFIC_ONE);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeStateMerge(cwd, patch) {
  const filePath = path.join(cwd, TRAFFIC_ONE);
  let current = {};
  if (fs.existsSync(filePath)) {
    try {
      current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      current = {};
    }
  }
  const merged = { ...current, ...patch };
  delete merged.pluginVersion;
  const pluginVersion = getPluginVersion();
  if (pluginVersion) {
    merged.version = pluginVersion;
  }
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort; the runner never throws
  }
}

function tryInstall() {
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

function runGraphify(cwd) {
  // graphify's CLI requires a subcommand. `update <path>` is the right one
  // for "(re-)extract code files and write graphify-out/{GRAPH_REPORT.md,
  // graph.json, graph.html}". Works on a fresh directory too — no separate
  // init step. Bare `graphify .` was wrong (the CLI treats `.` as an unknown
  // command); the previous spec we'd been following was outdated.
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

const REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

function bootstrap(cwd = process.cwd(), opts = {}) {
  const startedAt = Date.now();
  const reportRel = path.join('graphify-out', 'GRAPH_REPORT.md');
  const reportAbs = path.join(cwd, reportRel);

  // Opt-out: a future user can set `graphifyAutoRun: false` in .traffic-one.json
  // to disable foreground bootstrap. Today the default is unset (run).
  const state = readState(cwd);
  if (state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', report: null, error: 'graphifyAutoRun is false in .traffic-one.json', durationMs: 0 };
  }

  // Fresh-report short-circuit. Lets the orchestrator's Phase 5 invoke the
  // runner unconditionally without paying install/scan cost on every run.
  // Skip the short-circuit when opts.force === true.
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

  // Probe `graphify --version` and stamp `.traffic-one.json` → `toolchain.graphify`
  // so doctor.cjs + post-build hooks can compare installed vs recommended.
  let installedVersion = null;
  try {
    const { probeToolVersion, mergeToolchainStamp } = require(path.resolve(__dirname, 'toolchain.cjs'));
    installedVersion = probeToolVersion('graphify');
    if (installedVersion) {
      const current = readState(cwd);
      const updated = mergeToolchainStamp(current, 'graphify', {
        version: installedVersion,
        at: nowIso(),
      });
      writeStateMerge(cwd, { toolchain: updated.toolchain });
    }
  } catch {
    // best-effort; never fail the run because the version probe glitched.
  }

  writeStateMerge(cwd, { graphifyLastRunAt: nowIso() });

  // Write the compact graph preview so subagent SessionStart hooks can inline
  // a ~500-token module listing instead of forcing each subagent to Read the
  // full GRAPH_REPORT.md to scope its work.
  try {
    const { writeGraphPreview } = require(path.resolve(__dirname, 'hook-runtime', 'materialize', 'materialize.cjs'));
    writeGraphPreview(cwd, 'graphify');
  } catch {
    // best-effort; never fail the run because preview write glitched.
  }

  return { ok: true, action, report: reportAbs, error: null, durationMs: Date.now() - startedAt, installedVersion };
}

module.exports = { bootstrap, which, nowIso };

// CLI entry: `node scripts/graphify-runner.cjs` runs the bootstrap from cwd
// and prints a one-line JSON summary on stdout. Exit code is 0 on success
// AND on graceful skip — the caller is the post-build hook, which should
// never block the user's flow on a non-zero exit from this helper.
if (require.main === module) {
  const result = bootstrap(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}
