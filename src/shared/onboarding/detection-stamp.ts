// src/shared/onboarding/detection-stamp.ts
// The single writer of an EXISTING codebase's detection stamp (mode, stack,
// backend/frontend/realtime/mobile, confirmed, onboardingComplete, autoDetected,
// evidence, maintenance lifecycle). Shared by the SessionStart auto-detect flow
// and the onboarding-wait runner's consent path — the sibling of seed-prompt.ts
// (the other "first durable write at decision time" helper) and the
// existing-codebase counterpart of repair.ts.
//
// Why the runner needs it: SessionStart deliberately writes NOTHING while the
// use-plugin question is pending, so a project onboarded in ONE sitting used to
// keep a bare `{originalPrompt, version}` seed. materializeProjectIfNeeded then
// bails (no stack, no mode, onboardingComplete unset) and the project is never
// materialized — and a mode-less `.one.json` also fails isOnboardedProjectRoot,
// so it cannot even anchor root resolution. Stamping at consent time closes both.

import * as path from 'path';

import { type Rec } from '../obj';
import { detectMode, detectStackFromCodebase } from '../detection';
import { isUnclaimedWorkspaceSubPackage } from '../hook/paths';
import { dirOwnsProject, projectMembershipRoot } from '../project-membership';
import { nowIsoNoMs } from '../text';
import {
  maintenanceLifecycle,
  normalizeState,
  readEffectiveState,
  recordRunStackDrift,
  runIdentityFrozen,
  stackFingerprint,
  writeState,
} from '../state';
import { pluginUseDeclined, pluginUseEnabled } from '../state/plugin-use';

// `StackDetection` is module-private in shared/detection; derive it from the detector.
type StackDetection = ReturnType<typeof detectStackFromCodebase>;

export type DetectionStampSkip =
  | 'consent-missing'
  | 'declined'
  | 'not-existing-mode'
  | 'workspace-sub-package'
  | 'belongs-to-enclosing-project'
  | 'undetectable'
  | 'write-failed';

export interface DetectionStampResult {
  stamped: boolean;
  reason?: DetectionStampSkip;
  /** Present whenever detection ran, including on a skip. */
  detected?: StackDetection;
}

export interface DetectionStampOptions {
  /**
   * Stamp into THIS state object instead of a fresh read. SessionStart passes its
   * live `state` so everything downstream (capability profile, materialization
   * stamp, code graph, header) keeps seeing one object.
   */
  state?: Rec;
  /** Set false to mutate only — the caller owns the single writeState. */
  persist?: boolean;
  /**
   * Invent `stack: 'minimal'` when detection finds nothing. SessionStart passes
   * true (its historical behavior). Runners MUST NOT: stackRoutingState
   * deliberately invents no floor, so a floored stack would make
   * nextLocalPreferenceStep return 'open-code' and conjure a wizard for a sparse
   * repo that has none today.
   */
  floorMinimal?: boolean;
  /**
   * Require a recorded YES before writing. Runners pass true — they can be invoked
   * before the user has answered. SessionStart leaves it off: it only reaches its
   * auto-detect flow once the question is no longer pending, and gating on a
   * recorded choice there would stop stamping entirely when ask-first is disabled.
   */
  requireRecordedConsent?: boolean;
}

const skip = (reason: DetectionStampSkip, detected?: StackDetection): DetectionStampResult => (
  { stamped: false, reason, ...(detected ? { detected } : {}) }
);

/**
 * Detect and apply the stamp into `state`, in memory only. UNGUARDED by design —
 * the caller owns eligibility. SessionStart's auto-detect flow uses this directly
 * because it has already established mode + consent and must never be left with a
 * half-stamped state; runners go through stampExistingCodebaseDetection below.
 *
 * `floorMinimal` invents `stack: 'minimal'` when detection finds nothing.
 */
export function applyExistingCodebaseDetection(
  cwd: string,
  state: Rec,
  mode: string,
  options: { floorMinimal?: boolean } = {},
): StackDetection | null {
  const detected = detectStackFromCodebase(cwd);
  if (!detected.stack) {
    if (!options.floorMinimal) return null;
    detected.stack = 'minimal';
    detected.backend = detected.backend || 'other';
    detected.realtime = detected.realtime || 'none';
    detected.evidence.push('existing codebase detected → apply minimal stack baseline');
  }

  // A run in flight owns the project's stack identity until it settles: detection
  // reads the project's OWN files, so a team building what it was asked to build
  // moves the fingerprint under itself, and re-stamping mid-run invalidates every
  // live role claim at once. The drift is recorded; the next run mints with it.
  const identityFrozen = runIdentityFrozen(cwd, state);
  if (identityFrozen) recordRunStackDrift(cwd, state, stackFingerprint(detected));

  Object.assign(state, {
    mode,
    ...(identityFrozen ? {} : {
      stack: detected.stack,
      backend: detected.backend || 'other',
      frontend: detected.frontend || 'none',
      ...(detected.mobile ? { mobile: detected.mobile } : {}),
      realtime: detected.realtime || 'none',
    }),
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: nowIsoNoMs(),
    autoDetected: true,
    evidence: detected.evidence,
    // An existing codebase is already built → maintenance phase from first
    // detection, so post-build triage applies to the user's first prompt.
    lifecycle: maintenanceLifecycle('existing-detected'),
  });
  normalizeState(state, mode);
  return detected;
}

/**
 * Guarded, persisting stamp for callers that must decide eligibility themselves —
 * the onboarding-wait runner. Idempotent: a second call converges (normalizeState
 * reports no change and writeState is lock-protected).
 */
export function stampExistingCodebaseDetection(
  cwd: string,
  options: DetectionStampOptions = {},
): DetectionStampResult {
  // A declined project stays byte-identical forever; a runner must additionally
  // wait for the recorded yes so nothing lands before the user answers.
  if (pluginUseDeclined(cwd)) return skip('declined');
  if (options.requireRecordedConsent && !pluginUseEnabled(cwd)) return skip('consent-missing');

  const state = options.state || (readEffectiveState(cwd) as Rec);
  const mode = (typeof state.mode === 'string' && state.mode) || detectMode(cwd);
  // A new project's stack is owned by the wizard's `finalize` answer, never by
  // detection — it has no code to detect yet.
  if (!mode.startsWith('existing')) return skip('not-existing-mode');
  // Never stamp a directory that is not a project in its own right: a monorepo
  // sub-package belongs to its workspace root, and a subdirectory of a repo belongs
  // to that repo. writeState vetoes the same shape, but stopping here also keeps the
  // in-memory `persist: false` path (SessionStart) from half-stamping a state object.
  if (isUnclaimedWorkspaceSubPackage(cwd)) return skip('workspace-sub-package');
  if (!dirOwnsProject(cwd) && projectMembershipRoot(path.dirname(path.resolve(cwd))) !== null) {
    return skip('belongs-to-enclosing-project');
  }

  const detected = applyExistingCodebaseDetection(cwd, state, mode, {
    floorMinimal: options.floorMinimal,
  });
  // Undetectable and no floor requested: leave the project exactly as it is, so a
  // sparse repo keeps today's no-wizard behavior.
  if (!detected) return skip('undetectable');

  if (options.persist === false) return { stamped: true, detected };
  try {
    writeState(cwd, state);
  } catch {
    // Best-effort: the SessionStart auto-detect flow still stamps on a later
    // session, and the gate's materialize-then-retry remains the backstop.
    return skip('write-failed', detected);
  }
  return { stamped: true, detected };
}
