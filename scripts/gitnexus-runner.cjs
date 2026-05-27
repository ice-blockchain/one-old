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
//
// This file is the CLI entry + public surface. The implementation lives in
// one-file-per-function modules under `scripts/gitnexus-runner/`; this entry
// only re-exports them and runs `bootstrap()` when invoked directly.

const { bootstrap } = require('./gitnexus-runner/bootstrap.cjs');
const { which } = require('./gitnexus-runner/which.cjs');
const { nowIso } = require('./gitnexus-runner/nowIso.cjs');
const { currentNodeMajor } = require('./gitnexus-runner/currentNodeMajor.cjs');
const { nodeVersionMismatchMessage } = require('./gitnexus-runner/nodeVersionMismatchMessage.cjs');
const { findNvmNode22 } = require('./gitnexus-runner/findNvmNode22.cjs');
const { nvmPresent } = require('./gitnexus-runner/nvmPresent.cjs');
const { nvmInstallCommand } = require('./gitnexus-runner/nvmInstallCommand.cjs');
const { CONFLICT_PATHS, GITNEXUS_MIN_NODE_MAJOR } = require('./gitnexus-runner/_helpers.cjs');

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
