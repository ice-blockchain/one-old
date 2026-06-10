// src/modules/materialize/build-complete.ts
// Guarded fallback that flips a finished new-project build to the "maintenance"
// lifecycle phase. The PRIMARY signal is the orchestrator's explicit Phase-5
// write (source: "orchestrator"); this heuristic is the safety net for an
// orchestrated build whose explicit signal never landed (interrupted run, an
// older orchestrator). It is intentionally conservative — every guard must hold,
// so a still-building project is never misrouted to trivial handling:
//   • new-project + onboarding finalized (caller's responsibility)
//   • not already in maintenance
//   • an architect digest exists (the orchestrator actually planned a build) —
//     this is the subagent-handoff artifact, so the heuristic only ever fires for
//     subagent-mode builds; main-agent (low-performance) builds rely solely on the
//     explicit Phase-5 write and are never flipped mid-build by this path
//   • no subagent currently in flight (never flip mid-orchestration)
//   • the codebase has real output (source-file count well past the new-project bar)

import * as fs from 'fs';
import * as path from 'path';

import { countSourceFiles } from '../../shared/detection';
import { hasActiveRunClaims, isMaintenancePhase, markMaintenance } from '../../shared/state';

// Floor only — the digest + no-active-claims guards already prove the orchestrator
// ran and settled. Comfortably above detectMode's `≤5 files = new-project` bar.
const MAINTENANCE_FILE_THRESHOLD = 15;

function architectDigestExists(root: string): boolean {
  const digests = path.join(root, '.traffic-one', 'digests');
  try {
    if (!fs.existsSync(digests)) return false;
    for (const entry of fs.readdirSync(digests, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(digests, entry.name, 'architect.md'))) return true;
    }
  } catch {
    // best-effort
  }
  return false;
}

// Returns true iff it flipped the project to maintenance. Best-effort — never
// throws (a state-IO failure must not break the PostToolUse hook). The caller
// gates the cheap conditions (new-project, not-already-maintenance, onboarding
// done) so the expensive disk scans here only run during the building window.
export function maybeFlipToMaintenance(root: string, state: unknown): boolean {
  try {
    const mode = state && typeof state === 'object' ? (state as { mode?: unknown }).mode : undefined;
    if (mode !== 'new-project') return false;
    if (isMaintenancePhase(state, 'new-project')) return false;
    if (!architectDigestExists(root)) return false;
    if (hasActiveRunClaims(root, state)) return false;
    if (countSourceFiles(root) <= MAINTENANCE_FILE_THRESHOLD) return false;
    return markMaintenance(root, 'heuristic');
  } catch {
    return false;
  }
}
