// src/shared/state/lifecycle.ts
// Project lifecycle phase: "building" (initial scaffold in progress) vs
// "maintenance" (main build complete; the user is iterating, so post-build triage
// applies). Existing codebases are maintenance from the first detection; new
// projects flip once the initial build finishes (orchestrator Phase 5, or the
// guarded PostToolUse heuristic in materialize/post-stack-setup). Absence of
// `state.lifecycle` is valid and inferred from `mode` — there is no migration.
// The reader is tolerant of hand-edited casing/whitespace so we never touch the
// "ported 1:1" canonicalize/normalize shape functions for this optional field.

import { obj } from '../obj';
import { LIFECYCLE_PHASE_IDS } from '../../config/state';
import { stateTimestamp } from './io';
import { readState, writeState } from './normalize';
import { releaseAllRunClaims } from './run-agent';
import { ensureInitialCommit } from '../git-init';

type LifecyclePhase = 'building' | 'maintenance';

interface LifecycleState {
  phase: LifecyclePhase;
  source?: string;
  completedAt?: string;
}

// One normalization for every mode reader in this file: the header's
// hand-edited-casing tolerance must mean the same thing to phase inference and
// to the architecture-gate stand-down, or the same state can read as an
// existing codebase to one and a building project to the other.
function normalizedMode(mode: unknown): string {
  return typeof mode === 'string' ? mode.trim().toLowerCase() : '';
}

// Any existing-* mode (`existing-codebase`, `existing-with-supabase`) is "already
// built" → maintenance from the start. Everything else (new-project / unknown)
// defaults to building until something flips it.
function inferPhaseFromMode(mode: unknown): LifecyclePhase {
  return normalizedMode(mode).startsWith('existing') ? 'maintenance' : 'building';
}

// Existing-* modes (`existing-codebase`, `existing-with-supabase`): the repo
// predates Traffic One, so ARCHITECTURE enforcement (prescribed stack, styling,
// layout, plan-first) never applies — rules and skills remain guidance only.
// Deliberately keyed on the RAW mode, not projectPhase/isMaintenancePhase: a
// completed new-project build flips lifecycle to maintenance while its
// architecture gates must keep applying, and an absent/unknown mode must keep
// gates armed (fail closed) rather than standing them down.
export function isExistingProjectMode(state: unknown): boolean {
  return normalizedMode(obj(state)?.mode).startsWith('existing');
}

export function projectPhase(state: unknown, mode?: unknown): LifecyclePhase {
  const lifecycle = obj(obj(state)?.lifecycle);
  const phaseRaw = typeof lifecycle?.phase === 'string' ? lifecycle.phase.trim().toLowerCase() : '';
  if (LIFECYCLE_PHASE_IDS.has(phaseRaw)) return phaseRaw as LifecyclePhase;
  const effectiveMode = mode !== undefined ? mode : obj(state)?.mode;
  return inferPhaseFromMode(effectiveMode);
}

export function isMaintenancePhase(state: unknown, mode?: unknown): boolean {
  return projectPhase(state, mode) === 'maintenance';
}

// The completion watermark: when the lifecycle was last stamped. Run claims
// created BEFORE this moment belong to a finished build/run and must not
// suppress post-build triage on the user's next prompt.
export function lifecycleCompletedAt(state: unknown): string | null {
  const lifecycle = obj(obj(state)?.lifecycle);
  const at = typeof lifecycle?.completedAt === 'string' ? lifecycle.completedAt.trim() : '';
  return at || null;
}

// Canonical maintenance lifecycle object, stamped with the shared (ms-stripped)
// timestamp. `source` is recorded best-effort and not validated here — callers
// pass one of LIFECYCLE_SOURCE_IDS.
export function maintenanceLifecycle(source: string): LifecycleState {
  return { phase: 'maintenance', source, completedAt: stateTimestamp() };
}

// Persist the maintenance flag for the project at `cwd`. Mostly idempotent:
// returns false (no write) when the project is already in maintenance — EXCEPT
// for the orchestrator source, which refreshes `completedAt` so the watermark
// tracks the LATEST completed run (a maintenance-phase single-feature run would
// otherwise leave its claims looking "active" and suppress triage for up to 30
// minutes after it finishes). Best-effort — never throws (state IO failures must
// not break a hook). Reads the raw on-disk state (not the local-prefs merge) so
// the write round-trips cleanly through writeState.
export function markMaintenance(cwd: string, source: string): boolean {
  try {
    const state = readState(cwd);
    if (projectPhase(state, state.mode) === 'maintenance' && source !== 'orchestrator') return false;
    writeState(cwd, { ...state, lifecycle: maintenanceLifecycle(source) });
    // The build is settled: sweep the run's agent claims (pending deleted, claimed →
    // released) so finished runs never read as in-flight to hasActiveRunClaims.
    releaseAllRunClaims(cwd, 'maintenance-flip');
    // Main build complete → give a never-committed scaffold its initial git commit so
    // OpenCode delegation (which needs a HEAD to sandbox) works for free from here on.
    // Idempotent + best-effort: a no-op for an already-committed repo or a non-git dir.
    ensureInitialCommit(cwd);
    return true;
  } catch {
    return false;
  }
}
