'use strict';

// scripts/hook-runtime/handlers.cjs
// Five handlers, one per hook subcommand. Each is a pure function:
//   input → { stdout, exitCode } (no side effects on stdin/stdout/stderr).
// The thin entry script (`scripts/hook-runtime.cjs`) wires stdin/stdout
// around them.
//
// This is the thin "main" of the handlers/ folder: the function bodies live in
// cohesive themed sibling files (auth, session-start, prompt-submit, gates,
// post) sharing _helpers.cjs. This module re-exports the identical public
// surface the original single-file handlers.cjs exposed.

const { runSessionStart } = require('./session-start.cjs');
const { runUserPromptSubmit } = require('./prompt-submit.cjs');
const {
  runCheckOnboardingGate,
  runCheckAgentModel,
  runCheckArchitectureWrite,
  runCheckLibraryAllowlist,
  forbiddenForStack,
} = require('./gates.cjs');
const {
  runPostBuildPageSpeed,
  runPostStackSetup,
  runMaterializeProject,
  runPostFunctionEdit,
  runPreGraphifyHint,
  runPostBuildGraphifyHint,
} = require('./post.cjs');
const { authRequiredHookResult } = require('./auth.cjs');

module.exports = {
  runSessionStart,
  runUserPromptSubmit,
  runCheckOnboardingGate,
  runCheckAgentModel,        // PreToolUse(Task) → enforce performance-level model
  runCheckArchitectureWrite,
  runCheckLibraryAllowlist,
  runPostBuildPageSpeed,
  runPostStackSetup,
  runMaterializeProject,
  runPostFunctionEdit,      // exported for testing + entrypoint dispatch
  runPreGraphifyHint,        // PreToolUse(Glob|Grep) → graph hint
  runPostBuildGraphifyHint,  // PostToolUse(Bash) → post-build install/build hint
  forbiddenForStack,         // exported for testing
  authRequiredHookResult,    // exported for hook-runtime fail-closed fallback
};
