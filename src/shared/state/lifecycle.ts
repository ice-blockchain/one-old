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

export type LifecyclePhase = 'building' | 'maintenance';

export interface LifecycleState {
  phase: LifecyclePhase;
  source?: string;
  completedAt?: string;
}

// Any existing-* mode (`existing-codebase`, `existing-with-supabase`) is "already
// built" → maintenance from the start. Everything else (new-project / unknown)
// defaults to building until something flips it.
function inferPhaseFromMode(mode: unknown): LifecyclePhase {
  return typeof mode === 'string' && mode.startsWith('existing') ? 'maintenance' : 'building';
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
    return true;
  } catch {
    return false;
  }
}
