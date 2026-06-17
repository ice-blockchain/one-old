// src/modules/materialize/build-complete.ts
// Guarded fallback that flips a finished new-project build to the "maintenance"
// lifecycle phase. The PRIMARY signal is the orchestrator's explicit Phase-5
// write (source: "orchestrator"); this heuristic is the safety net for an
// orchestrated build whose explicit signal never landed (interrupted after
// review, an older orchestrator). It is intentionally conservative — every guard
// must hold, so a still-building project is never misrouted to trivial handling:
//   • new-project + onboarding finalized (caller's responsibility)
//   • not already in maintenance
//   • the build reached VERIFICATION with a TERMINAL verdict — a reviewer
//     `APPROVED` + tester `TESTS_GREEN` (or a shipper digest). Mere EXISTENCE of a
//     reviewer/tester digest is NOT enough: the file is created when the role
//     first runs (Phase 3) and re-emitted on every fix-cycle pass, so a live
//     review→fix→re-review loop (verdict still `CHANGES_REQUESTED` / `TESTS_FAILING`)
//     would otherwise trip this path mid-verification. Requiring a terminal verdict
//     means a build still being reviewed/fixed — or blocked before review — stays
//     "building" until it genuinely settles (or the orchestrator's Phase-5 stamp lands).
//   • no subagent currently in flight (never flip mid-orchestration)
//   • the codebase has real output (source-file count well past the new-project bar)

import { countSourceFiles } from '../../shared/detection';
import { anyRunReachedTerminalVerdict, hasActiveRunClaims, isMaintenancePhase, markMaintenance } from '../../shared/state';

// Floor only — the terminal-verdict + no-active-claims guards already prove the
// orchestrator ran through review and settled. Comfortably above detectMode's
// `≤5 files = new-project` bar.
const MAINTENANCE_FILE_THRESHOLD = 15;

// The build reached verification AND it terminally settled: reviewer APPROVED +
// tester TESTS_GREEN, or a shipper digest. Existence-only would false-positive on a
// mid-fix-cycle digest (see header), so this delegates to the verdict-aware reader.
function reachedVerification(root: string): boolean {
  return anyRunReachedTerminalVerdict(root);
}

// Returns true iff it flipped the project to maintenance. Best-effort — never
// throws (a state-IO failure must not break the hook). The caller gates the cheap
// conditions (new-project, not-already-maintenance, onboarding done) so the
// expensive disk scans here only run during the building window.
//
// `opts.atPromptBoundary` is set when called from UserPromptSubmit (a NEW user prompt
// ⇒ the prior orchestration turn has ENDED). There, leftover PENDING claims are not
// in-flight work — and on Cursor they NEVER activate or clear, so the no-active-claims
// guard would otherwise pin a finished build in "building" forever and mis-gate every
// maintenance request. So at the prompt boundary we skip that guard (the verification-
// digest + file-count guards still prove the build actually reached Phase-3+). During
// a turn (PostToolUse) the guard stays, so a long/blocked build is never flipped
// mid-recovery.
export function maybeFlipToMaintenance(root: string, state: unknown, opts: { atPromptBoundary?: boolean } = {}): boolean {
  try {
    const mode = state && typeof state === 'object' ? (state as { mode?: unknown }).mode : undefined;
    if (mode !== 'new-project') return false;
    if (isMaintenancePhase(state, 'new-project')) return false;
    if (!reachedVerification(root)) return false;
    if (!opts.atPromptBoundary && hasActiveRunClaims(root, state)) return false;
    if (countSourceFiles(root) <= MAINTENANCE_FILE_THRESHOLD) return false;
    return markMaintenance(root, opts.atPromptBoundary ? 'prompt-boundary' : 'heuristic');
  } catch {
    return false;
  }
}
