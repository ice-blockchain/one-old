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

// ── nvm-aware Node-22 binary discovery ──────────────────────────────────────
// Claude Code's hook process inherits the PATH it was launched with. Once
// the user runs `nvm alias default 22`, only NEW shells see Node 22 — the
// running Claude Code session still resolves `node` / `npm` / `gitnexus`
// against the older Node nvm folder. That's confusing for beginners who
// "did everything you told me" and still hit failures.
//
// Workaround: don't trust PATH. Glob `~/.nvm/versions/node/v22.*` directly,
// pick the highest installed v22.x.y, and use ABSOLUTE paths for node, npm,
// and gitnexus. PATH-independent. No relaunch required.
//
// Returns `{ root, node, npm, gitnexus, version }` where every value is an
// absolute path OR null when the binary doesn't exist. Returns `null` when
// no v22.* nvm install exists at all.
function findNvmNode22() {
  const home = process.env.HOME || '';
  if (!home) return null;
  const nodesRoot = path.join(home, '.nvm', 'versions', 'node');
  if (!fs.existsSync(nodesRoot)) return null;
  let candidates;
  try {
    candidates = fs.readdirSync(nodesRoot);
  } catch {
    return null;
  }
  // Match v22.x.y; pick the highest by semantic minor/patch sort.
  const v22s = candidates
    .filter((name) => /^v22\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [, am, ap] = a.match(/^v22\.(\d+)\.(\d+)$/) || [];
      const [, bm, bp] = b.match(/^v22\.(\d+)\.(\d+)$/) || [];
      if (Number(am) !== Number(bm)) return Number(bm) - Number(am);
      return Number(bp) - Number(ap);
    });
  if (v22s.length === 0) return null;
  const version = v22s[0];
  const root = path.join(nodesRoot, version);
  const bin = path.join(root, 'bin');
  function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
  return {
    root,
    version,
    node: exists(path.join(bin, 'node')) ? path.join(bin, 'node') : null,
    npm: exists(path.join(bin, 'npm')) ? path.join(bin, 'npm') : null,
    gitnexus: exists(path.join(bin, 'gitnexus')) ? path.join(bin, 'gitnexus') : null,
  };
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

// Detect whether nvm is installed at all (looks for `~/.nvm/nvm.sh` — the
// canonical nvm script). nvm is a shell function, not a binary, so we can't
// `which` it; the script's presence is the reliable signal.
function nvmPresent() {
  const home = process.env.HOME || '';
  if (!home) return false;
  return fs.existsSync(path.join(home, '.nvm', 'nvm.sh'));
}

// Single-line bash command the agent can hand to the Bash tool. Sources the
// nvm script first because nvm is a shell function, then installs + sets
// default. Bash tool permission prompt is the user's consent — the runner
// itself never executes this.
function nvmInstallCommand() {
  return (
    `bash -lc '. "$HOME/.nvm/nvm.sh" `
    + `&& nvm install ${GITNEXUS_MIN_NODE_MAJOR} `
    + `&& nvm alias default ${GITNEXUS_MIN_NODE_MAJOR} `
    + `&& nvm use default `
    + `&& npm install -g gitnexus'`
  );
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

  // Resolve gitnexus the seamless way:
  //   1. If `~/.nvm/versions/node/v22.*/bin/gitnexus` exists → use that
  //      absolute path. PATH-independent. No relaunch required even when
  //      Claude Code's hook shell was snapshotted on an older Node.
  //   2. Otherwise if `gitnexus` resolves on PATH → use that.
  //   3. Otherwise install: prefer `<nvm-v22-npm> install -g gitnexus` so
  //      the binary lands in the v22 nvm folder regardless of which Node is
  //      currently active.
  //   4. Only refuse with node-version-mismatch when ALL of: no nvm-v22
  //      install present, no `gitnexus` on PATH, AND current Node <22.
  const nvm22 = findNvmNode22();
  const hasGitnexusOnPath = which('gitnexus') !== null;
  const hasAbsoluteGitnexus = !!(nvm22 && nvm22.gitnexus);
  const major = typeof opts.nodeMajor === 'number' ? opts.nodeMajor : currentNodeMajor();
  const canInstallOnV22 = !!(nvm22 && nvm22.npm);

  // Refuse early only if there's no path forward: no v22 nvm install AND
  // no gitnexus on PATH AND current Node is too old to install gitnexus.
  if (
    !hasAbsoluteGitnexus
    && !hasGitnexusOnPath
    && !canInstallOnV22
    && major !== null
    && major < GITNEXUS_MIN_NODE_MAJOR
  ) {
    // Two sub-cases for beginner UX:
    //   (a) nvm IS installed but has no v22 → emit `nvm-install-needed`
    //       with a single-line bash command the agent can hand to its
    //       Bash tool. The Bash permission prompt becomes the user's
    //       consent — the runner never executes nvm itself.
    //   (b) nvm is NOT installed → emit the generic version-mismatch
    //       message (which now also covers "install nvm first" as part
    //       of `nodeVersionMismatchMessage` if we choose to extend it).
    if (nvmPresent()) {
      const command = nvmInstallCommand();
      const error = (
        `GitNexus needs Node >=${GITNEXUS_MIN_NODE_MAJOR}. `
        + `nvm is installed but has no v${GITNEXUS_MIN_NODE_MAJOR} version yet.\n`
        + `One bash command sets it all up (install + default + gitnexus). `
        + `Run it via the Bash tool — the user's permission prompt is the consent gate:\n\n`
        + `  ${command}\n\n`
        + `After it succeeds, re-invoke the runner (or wait for the next post-build hook).`
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

  let action = 'used-existing';
  let useNpx = false;
  let gitnexusBin = hasAbsoluteGitnexus ? nvm22.gitnexus : null;
  if (!hasAbsoluteGitnexus && !hasGitnexusOnPath) {
    if (opts.skipInstall) {
      return { ok: false, action: 'install-skipped', report: null, error: 'gitnexus not on PATH and skipInstall=true', durationMs: 0 };
    }
    const installResult = tryInstall();
    action = installResult.action;
    if (installResult.gitnexusBin) gitnexusBin = installResult.gitnexusBin;
    if (installResult.fallback === 'npx' && which('npx')) {
      // Use `npx gitnexus@latest analyze .` for this run; future runs will
      // continue to use npx until the user fixes their npm prefix.
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
    // GitNexus writes its diagnostic tips to STDOUT, not stderr (verified
    // in the wild: "Not a git repository / pass --skip-git ..." landed on
    // stdout in trading-game). Surface stdout when stderr is empty so the
    // agent has something actionable to relay to the user instead of a
    // bare "gitnexus exited non-zero".
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
  findNvmNode22,
  nvmPresent,
  nvmInstallCommand,
};

if (require.main === module) {
  const result = bootstrap(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}
