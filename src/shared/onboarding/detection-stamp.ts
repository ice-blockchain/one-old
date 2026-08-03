// src/shared/onboarding/detection-stamp.ts
// The single writer of an EXISTING codebase's detection stamp (mode, stack,
// backend/frontend/realtime/mobile, confirmed, onboardingComplete, autoDetected,
// evidence, maintenance lifecycle). Shared by the SessionStart auto-detect flow,
// the onboarding-wait runner's consent path, and the agent-classification path —
// the sibling of seed-prompt.ts (the other "first durable write at decision
// time" helper) and the existing-codebase counterpart of repair.ts.
//
// Why the runner needs it: SessionStart deliberately writes NOTHING while the
// use-plugin question is pending, so a project onboarded in ONE sitting used to
// keep a bare `{originalPrompt, version}` seed. materializeProjectIfNeeded then
// bails (no stack, no mode, onboardingComplete unset) and the project is never
// materialized — and a mode-less `.one.json` also fails isOnboardedProjectRoot,
// so it cannot even anchor root resolution. Stamping at consent time closes both.
//
// When the deterministic tables derive NO stack, nothing is stamped: the caller
// routes the project to agent classification (`computeOnboarding` reports the
// 'tech-detect' step) and the agent's submission lands here through
// applyAgentTechClassification — same stamp shape, `autoDetected: false`.

import * as path from 'path';

import { type Rec } from '../obj';
import {
  classifyDetectedSurfaces,
  detectMode,
  detectStackFromCodebase,
  type StackDetection,
} from '../detection';
import { BACKEND_IDS, FRONTEND_IDS, MOBILE_FRAMEWORK_IDS } from '../../config/state';
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

// The one stamp tail both classification paths share: run-identity freeze check,
// the canonical Object.assign field list, then normalizeState. `autoDetected`
// distinguishes the deterministic scanner (true) from an agent submission (false).
function applyDetectionStamp(
  cwd: string,
  state: Rec,
  mode: string,
  detected: StackDetection,
  options: { autoDetected: boolean },
): void {
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
    autoDetected: options.autoDetected,
    evidence: detected.evidence,
    // An existing codebase is already built → maintenance phase from first
    // detection, so post-build triage applies to the user's first prompt.
    lifecycle: maintenanceLifecycle('existing-detected'),
  });
  normalizeState(state, mode);
}

/**
 * Detect and apply the stamp into `state`, in memory only. UNGUARDED by design —
 * the caller owns eligibility. SessionStart's auto-detect flow uses this directly
 * because it has already established mode + consent and must never be left with a
 * half-stamped state; runners go through stampExistingCodebaseDetection below.
 *
 * ALWAYS returns the detection. When it derived no stack, NOTHING is stamped —
 * the caller branches on `detected.stack` and routes to agent classification
 * (the detection's partial evidence becomes the agent's hints).
 */
export function applyExistingCodebaseDetection(
  cwd: string,
  state: Rec,
  mode: string,
): StackDetection {
  const detected = detectStackFromCodebase(cwd);
  if (!detected.stack) return detected;
  applyDetectionStamp(cwd, state, mode, detected, { autoDetected: true });
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

  const detected = applyExistingCodebaseDetection(cwd, state, mode);
  // Undetectable: leave the project exactly as it is and hand the partial
  // evidence back as agent-classification hints — computeOnboarding now reports
  // the 'tech-detect' step for this shape instead of reading it as done.
  if (!detected.stack) return skip('undetectable', detected);

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

// ── Agent classification ────────────────────────────────────────────────────

export interface AgentTechSubmission {
  frontend: string;
  backend: string;
  mobile?: string;
  realtime?: string;
  /** Short free-text proof the agent cites (e.g. "express in package.json"). */
  evidence?: string;
}

export type AgentTechClassificationResult =
  | { ok: true; stack: string; alreadyClassified: boolean }
  | { ok: false; reason: DetectionStampSkip | 'invalid-submission'; issues?: string[] };

export interface AgentTechClassificationOptions {
  /** Set false to mutate only — the caller owns the single writeState. */
  persist?: boolean;
  /**
   * Require a recorded YES before writing. The runner passes the live ask-first
   * setting: with ask-first disabled there is never a recorded choice, and
   * requiring one would block classification entirely (mirrors the stamp).
   */
  requireRecordedConsent?: boolean;
  /** Stamp into THIS state object instead of a fresh read (tests/sim). */
  state?: Rec;
}

// The agent's manual classification: validate the submitted SURFACES against the
// canonical id vocabularies, derive the stack via the same rule the scanner uses
// (classifyDetectedSurfaces — the agent never picks a stack id), then stamp the
// identical field list with `autoDetected: false` and agent-cited evidence.
export function applyAgentTechClassification(
  cwd: string,
  submission: AgentTechSubmission,
  options: AgentTechClassificationOptions = {},
): AgentTechClassificationResult {
  if (pluginUseDeclined(cwd)) return { ok: false, reason: 'declined' };
  if (options.requireRecordedConsent && !pluginUseEnabled(cwd)) {
    return { ok: false, reason: 'consent-missing' };
  }

  const state = options.state || (readEffectiveState(cwd) as Rec);
  const mode = (typeof state.mode === 'string' && state.mode) || detectMode(cwd);
  if (!mode.startsWith('existing')) return { ok: false, reason: 'not-existing-mode' };
  if (isUnclaimedWorkspaceSubPackage(cwd)) return { ok: false, reason: 'workspace-sub-package' };
  if (!dirOwnsProject(cwd) && projectMembershipRoot(path.dirname(path.resolve(cwd))) !== null) {
    return { ok: false, reason: 'belongs-to-enclosing-project' };
  }
  // Never overwrite a committed identity: detection may have succeeded between
  // the directive and the submission, or a second submission may race. The
  // committed stack wins (mirrors the wizard finalize rule).
  if (typeof state.stack === 'string' && state.stack) {
    return { ok: true, stack: state.stack, alreadyClassified: true };
  }

  // Defense in depth: the gate's command classifier already membership-checks the
  // argv, but this writer is also callable directly (sim/tests), so re-validate.
  const issues: string[] = [];
  const frontend = String(submission.frontend || '').trim();
  const backend = String(submission.backend || '').trim();
  const mobile = String(submission.mobile || 'none').trim();
  const realtime = String(submission.realtime || 'none').trim();
  if (!FRONTEND_IDS.has(frontend)) issues.push(`frontend must be one of: ${[...FRONTEND_IDS].join(', ')}`);
  if (!BACKEND_IDS.has(backend)) issues.push(`backend must be one of: ${[...BACKEND_IDS].join(', ')}`);
  if (!MOBILE_FRAMEWORK_IDS.has(mobile)) issues.push(`mobile must be one of: ${[...MOBILE_FRAMEWORK_IDS].join(', ')}`);
  if (realtime !== 'none' && realtime !== 'light') issues.push('realtime must be none or light');
  if (issues.length > 0) return { ok: false, reason: 'invalid-submission', issues };

  const evidenceSuffix = submission.evidence?.trim() ? ` (${submission.evidence.trim()})` : '';
  const detected: StackDetection = {
    stack: null,
    frontend: frontend === 'none' ? null : frontend,
    backend: backend === 'none' ? null : backend,
    realtime: realtime === 'light' ? 'light' : null,
    evidence: [
      `agent-classified: frontend=${frontend} backend=${backend} mobile=${mobile} realtime=${realtime}${evidenceSuffix}`,
    ],
    ...(mobile !== 'none'
      ? { mobile: { enabled: true, framework: mobile, source: 'explicit' } }
      : {}),
  };
  classifyDetectedSurfaces(detected);
  if (!detected.stack) {
    return {
      ok: false,
      reason: 'invalid-submission',
      issues: ['at least one surface is required — frontend, backend, or mobile must not all be none'],
    };
  }

  applyDetectionStamp(cwd, state, mode, detected, { autoDetected: false });
  if (options.persist === false) return { ok: true, stack: String(state.stack || detected.stack), alreadyClassified: false };
  try {
    writeState(cwd, state);
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, stack: String(state.stack || detected.stack), alreadyClassified: false };
}
