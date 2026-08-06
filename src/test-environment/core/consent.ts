// src/test-environment/core/consent.ts
// The ask-first "do you want to use Traffic One here?" answer, established the
// way production establishes it.
//
// Why this file exists: `projectWritesPermitted` (shared/state/plugin-use.ts) is
// default-CLOSED while the question is unanswered, so the fsjson/fs-text
// chokepoint refuses every write under `<project>/.traffic-one/**`. The harness
// never answered — buildCaseEnv isolated the prefs, pinned auth/host and
// suppressed the wizard, but recorded no choice — so every onb-*/sim-* case ran
// pre-consent: `.one.json` was never written and onboarding could never
// complete. Measured on one frozen tree: PASS 10 · FAIL 104, against PASS 65 ·
// FAIL 48 the same suite scores once the answer is on record. 104 assertions
// reported a product failure for one missing harness step.
//
// `npm test` cannot see that class at all: src/build/test-preload.mjs pins
// TRAFFIC_ONE_ASK_USE_PLUGIN='0' for every unit test, which disarms the fence
// suite-wide. So the answer is recorded HERE and the fence stays ARMED for every
// case — never by exporting TRAFFIC_ONE_ASK_USE_PLUGIN=0 into a case env, which
// would reproduce that blindness in the one tier able to catch the next fence
// regression.
//
// Recorded through the ONBOARDING RUNNER's own handlers, not through
// recordPluginUseChoice directly: `applyUseChoice` is the function
// beginOnboardingAttempt dispatches to for `--use` (onboarding-wait/consent.ts)
// and `declineOutput` is the one main() calls for `--decline`
// (onboarding-wait/index.ts). Driving them means the harness proves the shipped
// consent commands still work, and a regression in argv handling or in the
// decline sweep surfaces here rather than only in a unit test. The runner's
// main() itself is not callable: every branch ends in process.exit, which would
// kill the harness.

import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { removePath, writeTextFile } from '../../shared/fsjson';
import { applyUseChoice, declineOutput } from '../../runners/onboarding-wait/wizard-output';
import {
  pluginUseDeclined,
  projectStateWriteAllowed,
  projectWritesPermitted,
  readPluginUseChoice,
} from '../../shared/state/plugin-use';

// Which answer this case starts from. Default 'use': every case that pre-seeds
// or drives onboarding represents a project the user opted into, which is what
// the harness always MEANT and never said.
export type CaseConsent = 'use' | 'decline';

// The probe path. Under `.traffic-one/debug/` on purpose: that subtree is pure
// runtime residue (DECLINE_ALWAYS_REMOVED sweeps it), so a probe there can never
// be mistaken for state a case depends on.
const PROBE_REL = path.join(STATE_DIR, 'debug', 'harness-consent-probe.json');

export interface ConsentFact {
  choice: CaseConsent;
  /** What the real reader reports after the runner handler ran. */
  recorded: { enabled: boolean; source: string } | null;
  declined: boolean;
  /** Where the answer landed, and whether that is the per-case isolated file. */
  prefsPath: string;
  prefsIsolated: boolean;
  /** The fence's own two verdicts for this project. */
  writesPermitted: boolean;
  stateWriteAllowed: boolean;
  /**
   * A real round trip through the declared IO chokepoint at a path inside
   * `<project>/.traffic-one/`. Reading the predicate alone would prove the
   * predicate; this proves the chokepoint is still WIRED to it, which is the
   * half that actually broke.
   */
  probe: 'landed' | 'refused';
  /** The `--decline` stdout contract, verbatim, for the decline direction. */
  declineOutput?: string;
}

/**
 * Record the case's answer and report what the fence then says. MUST be called
 * inside withCaseEnv (the runner handlers and the fence both read process.env)
 * and BEFORE anything writes project state.
 */
export function establishCaseConsent(
  projectRoot: string,
  choice: CaseConsent,
  caseFolder: string,
  env: NodeJS.ProcessEnv = process.env,
): ConsentFact {
  const fact: Partial<ConsentFact> = { choice };
  if (choice === 'decline') {
    // The runner's `--decline` branch: records the durable opt-out and sweeps
    // the pre-decline runtime residue (removeDeclinedProjectArtifacts).
    fact.declineOutput = declineOutput(projectRoot, 'claude');
  } else {
    // The runner's `--use` branch, argv included, so the seed-prompt handling
    // on that path is exercised rather than bypassed.
    applyUseChoice(projectRoot, ['--use', projectRoot], env);
  }

  const choiceOnRecord = readPluginUseChoice(projectRoot, env);
  // Never `path.resolve('')` — that answers the process cwd, which would make an
  // UNSET prefs path look like a resolved one and turn the isolation check below
  // into a coin toss.
  const configured = env.TRAFFIC_ONE_PROJECT_PREFS_PATH || '';
  const prefsPath = configured ? path.resolve(configured) : '';
  const probeTarget = path.join(projectRoot, PROBE_REL);
  const landed = writeTextFile(probeTarget, '{"harness":"consent-probe"}\n');
  // Never left behind: a case's own artifacts are the evidence, and a stray
  // harness file inside the state dir would show up in every later scan.
  // removePath is the fenced delete, so cleaning up cannot bypass the fence
  // either — on the decline direction it refuses, which is correct because
  // nothing was written.
  if (landed) removePath(probeTarget);

  return {
    choice,
    recorded: choiceOnRecord ? { enabled: choiceOnRecord.enabled, source: choiceOnRecord.source } : null,
    declined: pluginUseDeclined(projectRoot, env),
    prefsPath,
    // The maintainer's real ~/.traffic-one/projects/<hash>/preferences.json must
    // never be touched by a case. env.ts:31 points the variable at the case
    // folder; this records whether it actually did.
    prefsIsolated: Boolean(prefsPath) && prefsPath.startsWith(path.resolve(caseFolder) + path.sep),
    writesPermitted: projectWritesPermitted(projectRoot, env),
    stateWriteAllowed: projectStateWriteAllowed(path.join(projectRoot, STATE_FILE), env),
    probe: landed ? 'landed' : 'refused',
    ...(fact.declineOutput ? { declineOutput: fact.declineOutput } : {}),
  };
}

export function caseConsent(consent: CaseConsent | undefined): CaseConsent {
  return consent ?? 'use';
}
