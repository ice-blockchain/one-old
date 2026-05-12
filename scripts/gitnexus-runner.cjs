#!/usr/bin/env node
'use strict';

// scripts/gitnexus-runner.cjs
// Foreground GitNexus bootstrap. Mirror of `scripts/graphify-runner.cjs` —
// same return shape, same opt-out semantics — used by the post-build hook
// (handlers.cjs `runPostBuildCodeGraphHint`) and the orchestrator's Phase 5
// when `state.codeGraphProvider === 'gitnexus'`.
//
// Behaviour summary:
//   1. Honour `codeGraphAutoRun: false` opt-out (provider-agnostic).
//   2. Fresh-cache short-circuit: if `.gitnexus/` exists and is < 7 days old,
//      return { ok: true, action: 'fresh' } with no work.
//   3. Probe `gitnexus` on PATH. If found, jump to step 6.
//   4. Probe `npm`. If found, `npm install -g gitnexus`. On EACCES (no global
//      write access), fall back to `npx gitnexus@latest analyze .` for the
//      run step. If npm absent, return install-skipped.
//   5. Back up `AGENTS.md`, `CLAUDE.md`, `.claude/skills/` to
//      `.traffic-one/backups/<run-stamp>/` — GitNexus auto-writes those
//      paths and would otherwise clobber traffic-one's own context files.
//   6. Run `gitnexus analyze .` synchronously.
//   7. SHA-1-compare AGENTS.md / CLAUDE.md / .claude/skills with their
//      backups; restore traffic-one's versions if GitNexus overwrote them.
//   8. Stamp `gitnexusLastRunAt` on success / `gitnexusLastErrorAt` +
//      `gitnexusLastError` on failure. Caller decides what to do with the
//      result; this runner never throws.
//
// LICENSE NOTICE
// GitNexus is PolyForm Noncommercial-licensed. This runner only fires when
// the user has explicitly picked `codeGraphProvider: "gitnexus"` during
// onboarding — that choice in `.traffic-one.json` is the consent record.
// The runner emits a license reminder in its return payload so the calling
// hook can surface it in the agent's context.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TRAFFIC_ONE = '.traffic-one.json';
const GITNEXUS_DIR = '.gitnexus';
const REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const CONFLICT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/skills'];
// GitNexus's package.json declares `engines.node: ">=22"`. Running
// `npm install -g gitnexus` on a lower Node prints a noisy EBADENGINE error
// that beginners can't decode. We pre-flight here and refuse with a clean,
// actionable banner BEFORE wasting ~3 minutes on a doomed npm install.
const GITNEXUS_MIN_NODE_MAJOR = 22;

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function runStampForFs() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

function which(cmd) {
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' });
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
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort; the runner never throws
  }
}

function sha1OfPath(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    // Hash the recursive listing (paths + sizes); good enough to detect changes.
    const hash = crypto.createHash('sha1');
    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
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
    }
    walk(absPath);
    return hash.digest('hex');
  }
  return crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex');
}

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.copyFileSync(src, dst);
  }
}

function backupConflicts(cwd, runStamp) {
  const backupRoot = path.join(cwd, '.traffic-one', 'backups', runStamp);
  const recorded = [];
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

function restoreIfOverwritten(cwd, backups) {
  const restored = [];
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

// Returns the current Node major (e.g. 20 for v20.18.3). Pure read; never
// throws. Used by both bootstrap() and the post-stack-setup hook so we
// surface the upgrade hint at the earliest possible moment.
function currentNodeMajor() {
  const raw = process.versions && process.versions.node;
  if (typeof raw !== 'string') return null;
  const major = Number(raw.split('.')[0]);
  return Number.isFinite(major) ? major : null;
}

// Beginner-friendly upgrade message. Single source of truth so the runner,
// the post-build banner, and the post-stack-setup warning all use the same
// wording.
function nodeVersionMismatchMessage(major) {
  const have = major === null ? 'an unknown Node version' : `Node ${major}`;
  return (
    `GitNexus requires Node >=${GITNEXUS_MIN_NODE_MAJOR} (you have ${have}). `
    + 'Upgrade once, then relaunch Claude Code:\n'
    + `  nvm install ${GITNEXUS_MIN_NODE_MAJOR}\n`
    + `  nvm alias default ${GITNEXUS_MIN_NODE_MAJOR}\n`
    + `  nvm use default\n`
    + 'Or pick the `graphify` provider instead (Python; works on any Node) '
    + 'by editing `.traffic-one.json` -> `codeGraphProvider: "graphify"`.'
  );
}

function tryInstall() {
  if (!which('npm')) {
    return {
      action: 'install-skipped',
      error: '`npm` not on PATH. Install Node.js + npm or pick `graphify` as the codeGraphProvider.',
    };
  }
  const result = spawnSync('npm', ['install', '-g', 'gitnexus'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180 * 1000,
  });
  if (result.status === 0 && which('gitnexus')) {
    return { action: 'installed-npm-global', error: null };
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

function runGitnexus(cwd, opts) {
  // Prefer the directly-installed binary; fall back to `npx` when global
  // install was blocked by EACCES (tryInstall sets opts.useNpx).
  const cmd = opts.useNpx ? 'npx' : 'gitnexus';
  const args = opts.useNpx ? ['gitnexus@latest', 'analyze', '.'] : ['analyze', '.'];
  const result = spawnSync(cmd, args, {
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

function bootstrap(cwd = process.cwd(), opts = {}) {
  const startedAt = Date.now();
  const reportAbs = path.join(cwd, GITNEXUS_DIR);

  // Opt-out: provider-agnostic `codeGraphAutoRun: false` honoured; the older
  // `graphifyAutoRun: false` is also honoured for one version of forward
  // compatibility (it was the only opt-out flag before this PR).
  const state = readState(cwd);
  if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', report: null, error: 'codeGraphAutoRun is false in .traffic-one.json', durationMs: 0 };
  }

  // Fresh-cache short-circuit.
  if (!opts.force && fs.existsSync(reportAbs)) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(reportAbs).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs > 0 && (Date.now() - mtimeMs) < REPORT_FRESH_MS) {
      return { ok: true, action: 'fresh', report: reportAbs, error: null, durationMs: 0, license: 'PolyForm Noncommercial' };
    }
  }

  // Node version pre-flight. GitNexus needs Node >=22 to BOTH install AND
  // run — `npm install -g gitnexus` on Node <22 hits EBADENGINE, and a
  // gitnexus binary previously installed on a wrong Node (via `--force` or
  // a permissive npm config) crashes with `SyntaxError: Cannot use import
  // statement outside a module`. So check version BEFORE `which(gitnexus)`,
  // not inside the install branch. Refuse early with an actionable banner.
  // `opts.nodeMajor` lets tests inject a fake major without mucking with
  // process.versions (which is read-only on some Node releases).
  const major = typeof opts.nodeMajor === 'number' ? opts.nodeMajor : currentNodeMajor();
  if (major !== null && major < GITNEXUS_MIN_NODE_MAJOR) {
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

  let action = 'used-existing';
  let useNpx = false;
  if (!which('gitnexus')) {
    if (opts.skipInstall) {
      return { ok: false, action: 'install-skipped', report: null, error: 'gitnexus not on PATH and skipInstall=true', durationMs: 0 };
    }
    const installResult = tryInstall();
    action = installResult.action;
    if (installResult.fallback === 'npx' && which('npx')) {
      // Use `npx gitnexus@latest analyze .` for this run; future runs will
      // continue to use npx until the user fixes their npm prefix.
      useNpx = true;
      action = 'installed-npx-fallback';
    } else if (installResult.error || !which('gitnexus')) {
      writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: installResult.error || 'gitnexus still not on PATH after install attempt' });
      return { ok: false, action, report: null, error: installResult.error || 'gitnexus not available after install', durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial' };
    }
  }

  // Conflict mitigation: GitNexus auto-writes AGENTS.md / CLAUDE.md /
  // .claude/skills/ which overlap traffic-one's own. Back up first.
  const runStamp = runStampForFs();
  const backups = backupConflicts(cwd, runStamp);

  const run = runGitnexus(cwd, { useNpx });
  if (run.status !== 0) {
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: run.stderr || 'gitnexus exited non-zero' });
    return { ok: false, action, report: null, error: run.stderr || 'gitnexus exited non-zero', durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot };
  }

  // Restore traffic-one's versions of AGENTS.md / CLAUDE.md / .claude/skills
  // if GitNexus's run changed them.
  const restored = restoreIfOverwritten(cwd, backups);

  // Sanity-check that GitNexus actually produced its index.
  if (!fs.existsSync(reportAbs)) {
    writeStateMerge(cwd, { gitnexusLastErrorAt: nowIso(), gitnexusLastError: 'gitnexus ran but .gitnexus/ was not produced' });
    return { ok: false, action, report: null, error: 'gitnexus ran but .gitnexus/ was not produced', durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot, restored };
  }

  writeStateMerge(cwd, { gitnexusLastRunAt: nowIso() });
  return {
    ok: true,
    action,
    report: reportAbs,
    error: null,
    durationMs: Date.now() - startedAt,
    license: 'PolyForm Noncommercial',
    backupRoot: backups.backupRoot,
    restored,
  };
}

module.exports = {
  bootstrap,
  which,
  nowIso,
  CONFLICT_PATHS,
  GITNEXUS_MIN_NODE_MAJOR,
  currentNodeMajor,
  nodeVersionMismatchMessage,
};

if (require.main === module) {
  const result = bootstrap(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}
