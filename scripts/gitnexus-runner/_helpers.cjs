'use strict';

// scripts/gitnexus-runner/_helpers.cjs
// Module constants + private helpers for the foreground GitNexus bootstrap.
// The exported functions each live in their own sibling file and import what
// they need from here; the exported constants below are re-exported from the
// entry (scripts/gitnexus-runner.cjs).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getPluginVersion } = require('../hook-runtime/state/state.cjs');
const { which } = require('./which.cjs');
const { findNvmNode22 } = require('./findNvmNode22.cjs');

const TRAFFIC_ONE = path.join('.traffic-one', '.one.json');
const LEGACY_TRAFFIC_ONE = '.traffic-one.json';
const GITNEXUS_DIR = '.gitnexus';
const REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const CONFLICT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/skills'];
// GitNexus's package.json declares `engines.node: ">=22"`. Running
// `npm install -g gitnexus` on a lower Node prints a noisy EBADENGINE error
// that beginners can't decode. We pre-flight here and refuse with a clean,
// actionable banner BEFORE wasting ~3 minutes on a doomed npm install.
const GITNEXUS_MIN_NODE_MAJOR = 22;

function runStampForFs() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

function readState(cwd) {
  const filePath = path.join(cwd, TRAFFIC_ONE);
  const legacyPath = path.join(cwd, LEGACY_TRAFFIC_ONE);
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(readablePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeStateMerge(cwd, patch) {
  const filePath = path.join(cwd, TRAFFIC_ONE);
  const legacyPath = path.join(cwd, LEGACY_TRAFFIC_ONE);
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  let current = {};
  if (fs.existsSync(readablePath)) {
    try {
      current = JSON.parse(fs.readFileSync(readablePath, 'utf8'));
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

function tryInstall() {
  // Prefer the absolute nvm-v22 npm when available so the install lands in
  // the v22 nvm folder regardless of which Node is "active" in PATH. This
  // matters when Claude Code's hook shell was snapshotted before the user
  // bumped their nvm default to 22 — `npm` on PATH would still point at
  // Node 20, and installing gitnexus there places a broken binary that
  // crashes with `SyntaxError: Cannot use import statement` on every run.
  const nvm22 = findNvmNode22();
  let npmCmd;
  let installAction;
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

function runGitnexus(cwd, opts) {
  // Pick the gitnexus binary in this priority order:
  //   1. Explicit `opts.gitnexusBin` (set by tryInstall when it just placed
  //      the binary at an absolute path) — newest install wins.
  //   2. Absolute nvm-v22 gitnexus (`~/.nvm/versions/node/v22.*/bin/gitnexus`)
  //      — PATH-independent; works even when Claude Code's hook shell was
  //      snapshotted on an older Node.
  //   3. `npx gitnexus@latest` (set by tryInstall when global install
  //      hit EACCES) — slower but no global install needed.
  //   4. Bare `gitnexus` from PATH — last resort.
  let cmd;
  let baseArgs = ['analyze', '.'];
  const nvm22 = findNvmNode22();
  if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin)) {
    cmd = opts.gitnexusBin;
  } else if (opts.useNpx) {
    cmd = 'npx';
    baseArgs = ['gitnexus@latest', ...baseArgs];
  } else if (nvm22 && nvm22.gitnexus) {
    // Absolute path means we don't care what `gitnexus` resolves to on the
    // current shell's PATH. Critical for the "Claude Code session snapshotted
    // before nvm default was bumped" case.
    cmd = nvm22.gitnexus;
  } else {
    cmd = 'gitnexus';
  }
  // Fresh scaffolds typically don't have `.git/` initialised yet. GitNexus
  // refuses non-git folders by default with the tip
  //   "pass --skip-git to index any folder without a .git directory."
  // …which it writes to STDOUT, not stderr, so a naïve runner would surface
  // an opaque "gitnexus exited non-zero" with empty stderr. Pre-detect and
  // pass `--skip-git` ourselves when no `.git` lives at the project root.
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

module.exports = {
  TRAFFIC_ONE,
  GITNEXUS_DIR,
  REPORT_FRESH_MS,
  CONFLICT_PATHS,
  GITNEXUS_MIN_NODE_MAJOR,
  runStampForFs,
  readState,
  writeStateMerge,
  sha1OfPath,
  copyRecursive,
  backupConflicts,
  restoreIfOverwritten,
  tryInstall,
  runGitnexus,
};
