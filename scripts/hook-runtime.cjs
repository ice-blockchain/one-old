#!/usr/bin/env node
'use strict';

// scripts/hook-runtime.cjs — entry point for traffic-one hooks.
// Each hook in settings.json / hooks/hooks.json invokes:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-runtime.cjs" <subcommand>
//
// This file is intentionally tiny. The actual logic lives in
// `scripts/hook-runtime/`, organised by concern:
//
//   ├── config.cjs         constants, INFRA_CONFIG, pitch helpers, paths
//   ├── state.cjs          JSON I/O + .traffic-one.json read/write
//   ├── stacks.cjs         per-stack rule manifests (mandatory + optional)
//   ├── skill-filters.cjs  SKILL_FILTERS + cache surgery (prune/restore)
//   ├── detection.cjs      package.json probes + stack auto-detection
//   ├── packing.cjs        rule-bundle packer (budget-aware)
//   ├── directives.cjs     onboarding directive + auto-detect banner
//   └── handlers.cjs       the five hook handlers, all pure functions
//
// Add a new subcommand by appending to HANDLERS below and adding the matching
// handler in `hook-runtime/handlers.cjs`.

const config         = require('./hook-runtime/config.cjs');
const state          = require('./hook-runtime/state.cjs');
const stacks         = require('./hook-runtime/stacks.cjs');
const skillFilters   = require('./hook-runtime/skill-filters.cjs');
const detection      = require('./hook-runtime/detection.cjs');
const packing        = require('./hook-runtime/packing.cjs');
const directives     = require('./hook-runtime/directives.cjs');
const handlers       = require('./hook-runtime/handlers.cjs');

const { MAX_STDIN } = config;

const HANDLERS = {
  'session-start':            ()         => handlers.runSessionStart(),
  'user-prompt-submit':       (rawInput) => handlers.runUserPromptSubmit(rawInput),
  'check-onboarding-gate':     (rawInput) => handlers.runCheckOnboardingGate(rawInput),
  'check-architecture-write': (rawInput) => handlers.runCheckArchitectureWrite(rawInput),
  'check-library-allowlist':  (rawInput) => handlers.runCheckLibraryAllowlist(rawInput),
  'post-build-page-speed':    (rawInput) => handlers.runPostBuildPageSpeed(rawInput),
  'post-stack-setup':         (rawInput) => handlers.runPostStackSetup(rawInput),
  'pre-graphify-hint':        (rawInput) => handlers.runPreGraphifyHint(rawInput),
  'post-build-graphify':      (rawInput) => handlers.runPostBuildGraphifyHint(rawInput),
};

// ── stdin → string (capped at MAX_STDIN) ─────────────────────────────────────
function readStdinRaw() {
  return new Promise((resolve) => {
    let raw = '';
    let truncated = false;

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
        if (chunk.length > remaining) truncated = true;
        return;
      }
      truncated = true;
    });
    process.stdin.on('end',   () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated }));
  });
}

function normalizeResult(result) {
  if (!result) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  if (typeof result === 'string' || Buffer.isBuffer(result)) {
    return { stdout: String(result), stderr: '', exitCode: 0 };
  }
  return {
    stdout:   typeof result.stdout === 'string' ? result.stdout : '',
    stderr:   typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0,
  };
}

async function main() {
  const subcommand = process.argv[2];
  const handler = HANDLERS[subcommand];
  if (!handler) {
    process.stderr.write(`Unknown traffic-one hook subcommand: ${subcommand || '(missing)'}\n`);
    process.exitCode = 0;
    return;
  }

  const { raw } = await readStdinRaw();
  try {
    const result = normalizeResult(handler(raw));
    if (result.stderr) {
      process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    }
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`[traffic-one hook] ${subcommand} failed: ${error.message}\n`);
    if (subcommand === 'session-start') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '[PLUGIN MODE: UNKNOWN] Could not detect project state. Run the detect-project skill manually.',
        },
      }));
    }
    process.exitCode = 0;
  }
}

if (require.main === module) {
  main();
}

// Backward-compatible re-exports for tests / other tooling that may import
// from this file directly.
module.exports = {
  // constants
  MAX_STDIN:   config.MAX_STDIN,
  STACKS:      stacks.STACKS,
  SKILL_FILTERS: skillFilters.SKILL_FILTERS,
  // skill filters
  activeSkillsFor:        skillFilters.activeSkillsFor,
  listAllSkills:          skillFilters.listAllSkills,
  pruneSkillsDirective:   skillFilters.pruneSkillsDirective,
  pruneCacheSkills:       skillFilters.pruneCacheSkills,
  restoreDisabledSkills:  skillFilters.restoreDisabledSkills,
  // detection + packing + directives
  detectMode:                  detection.detectMode,
  detectStackFromCodebase:     detection.detectStackFromCodebase,
  classifyPromptForStack:      detection.classifyPromptForStack,
  packBundle:                  packing.packBundle,
  onboardingDirectiveNewProject: directives.onboardingDirectiveNewProject,
  autoDetectedAnnouncement:      directives.autoDetectedAnnouncement,
  // handlers
  forbiddenForStack:        handlers.forbiddenForStack,
  runCheckArchitectureWrite: handlers.runCheckArchitectureWrite,
  runCheckOnboardingGate:     handlers.runCheckOnboardingGate,
  runCheckLibraryAllowlist:  handlers.runCheckLibraryAllowlist,
  runPostBuildPageSpeed:     handlers.runPostBuildPageSpeed,
  runPostStackSetup:         handlers.runPostStackSetup,
  runSessionStart:           handlers.runSessionStart,
  runUserPromptSubmit:       handlers.runUserPromptSubmit,
  runPreGraphifyHint:        handlers.runPreGraphifyHint,
  runPostBuildGraphifyHint:  handlers.runPostBuildGraphifyHint,
};
