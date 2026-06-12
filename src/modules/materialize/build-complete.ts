// src/modules/materialize/build-complete.ts
// Guarded fallback that flips a finished new-project build to the "maintenance"
// lifecycle phase. The PRIMARY signal is the orchestrator's explicit Phase-5
// write (source: "orchestrator"); this heuristic is the safety net for an
// orchestrated build whose explicit signal never landed (interrupted after
// review, an older orchestrator). It is intentionally conservative — every guard
// must hold, so a still-building project is never misrouted to trivial handling:
//   • new-project + onboarding finalized (caller's responsibility)
//   • not already in maintenance
//   • the build reached VERIFICATION — a reviewer/tester/shipper digest exists
//     (Phase 3+). The architect digest alone is NOT enough: it lands minutes into
//     a build (Phase 1), so combined with the staleness-based no-active-claims
//     guard it could flip a long or BLOCKED build mid-recovery (the implementer
//     claims simply age out after 30 min). Requiring a Phase-3 artifact means a
//     build blocked before review never trips this path — it stays "building"
//     until the orchestrator's explicit Phase-5 stamp lands.
//   • no subagent currently in flight (never flip mid-orchestration)
//   • the codebase has real output (source-file count well past the new-project bar)

import * as fs from 'fs';
import * as path from 'path';

import { countSourceFiles } from '../../shared/detection';
import { hasActiveRunClaims, isMaintenancePhase, markMaintenance } from '../../shared/state';

// Floor only — the verification-digest + no-active-claims guards already prove the
// orchestrator ran through review and settled. Comfortably above detectMode's
// `≤5 files = new-project` bar.
const MAINTENANCE_FILE_THRESHOLD = 15;

// Phase-3+ handoff artifacts. Their presence proves the build reached verification
// (review/test) or shipping — i.e. the implementers finished, not just the
// architect's Phase-1 plan. (`frontend`/`backend` are Phase-2 implement digests and
// can exist while the build is still being reviewed/fixed, so they don't count.)
const VERIFICATION_DIGESTS = ['reviewer.md', 'tester.md', 'shipper.md'];

function reachedVerification(root: string): boolean {
  const digests = path.join(root, '.traffic-one', 'digests');
  try {
    if (!fs.existsSync(digests)) return false;
    for (const entry of fs.readdirSync(digests, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runDir = path.join(digests, entry.name);
      if (VERIFICATION_DIGESTS.some((name) => fs.existsSync(path.join(runDir, name)))) return true;
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
    if (!reachedVerification(root)) return false;
    if (hasActiveRunClaims(root, state)) return false;
    if (countSourceFiles(root) <= MAINTENANCE_FILE_THRESHOLD) return false;
    return markMaintenance(root, 'heuristic');
  } catch {
    return false;
  }
}
