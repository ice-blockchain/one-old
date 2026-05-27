'use strict';

const fs = require('fs');
const path = require('path');

const {
  GITNEXUS_DIR,
  REPORT_FRESH_MS,
  GITNEXUS_MIN_NODE_MAJOR,
  readState,
  writeStateMerge,
  runStampForFs,
  backupConflicts,
  restoreIfOverwritten,
  tryInstall,
  runGitnexus,
} = require('./_helpers.cjs');
const { which } = require('./which.cjs');
const { findNvmNode22 } = require('./findNvmNode22.cjs');
const { currentNodeMajor } = require('./currentNodeMajor.cjs');
const { nodeVersionMismatchMessage } = require('./nodeVersionMismatchMessage.cjs');
const { nvmPresent } = require('./nvmPresent.cjs');
const { nvmInstallCommand } = require('./nvmInstallCommand.cjs');
const { nowIso } = require('./nowIso.cjs');

function bootstrap(cwd = process.cwd(), opts = {}) {
  const startedAt = Date.now();
  const reportAbs = path.join(cwd, GITNEXUS_DIR);

  // Opt-out: provider-agnostic `codeGraphAutoRun: false` honoured; the older
  // `graphifyAutoRun: false` is also honoured for one version of forward
  // compatibility (it was the only opt-out flag before this PR).
  const state = readState(cwd);
  if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
    return { ok: false, action: 'install-skipped', report: null, error: 'codeGraphAutoRun is false in .traffic-one/.one.json', durationMs: 0 };
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

  // Probe the just-run binary's `--version` and stamp `.traffic-one/.one.json`
  // → `toolchain.gitnexus` so doctor.cjs + future runners can compare
  // installed-vs-recommended without re-probing. The actual binary used
  // is `run.binUsed` (set by runGitnexus); if absent, fall back to
  // discovering the nvm-v22 path or PATH lookup.
  let installedVersion = null;
  let probedBin = null;
  try {
    const { probeToolVersion, mergeToolchainStamp } = require(path.resolve(__dirname, '..', 'toolchain.cjs'));
    const binCandidate = run.binUsed || (nvm22 && nvm22.gitnexus) || (which('gitnexus') || null);
    if (binCandidate && fs.existsSync(binCandidate.replace(/\s.*/, ''))) {
      probedBin = binCandidate;
      installedVersion = probeToolVersion('gitnexus', { binPath: binCandidate });
    } else if (binCandidate) {
      // npx case — `binCandidate` is "npx" with args appended; just probe via PATH.
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
  // a ~500-token module listing instead of forcing each subagent to Read the
  // full .gitnexus/ artefacts to scope its work.
  try {
    const { writeGraphPreview } = require(path.resolve(__dirname, '..', 'hook-runtime', 'materialize', 'materialize.cjs'));
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

module.exports = { bootstrap };
