// src/modules/materialize/build-complete.ts
// Guarded fallback that flips a finished new-project build to the "maintenance"
// lifecycle phase. The PRIMARY signal is the orchestrator's explicit Phase-5
// write (source: "orchestrator"); this heuristic is the safety net for an
// orchestrated build whose explicit signal never landed (interrupted after
// review, an older orchestrator). It is intentionally conservative — every guard
// must hold, so a still-building project is never misrouted to trivial handling:
//   • new-project + onboarding finalized (caller's responsibility)
//   • not already in maintenance
//   • the build SETTLED — and what counts as "settled" depends on WHEN we check:
//       - DURING a turn (PostToolUse): a TERMINAL verdict — reviewer `APPROVED` +
//         tester `TESTS_GREEN` (or a shipper digest). Mere EXISTENCE of a reviewer/
//         tester digest is NOT enough: the file is created when the role first runs
//         (Phase 3) and re-emitted on every fix-cycle pass, so a live review→fix→
//         re-review loop (verdict still `CHANGES_REQUESTED`/`TESTS_FAILING`) would
//         otherwise trip this path mid-verification. Requiring a terminal verdict
//         means a build still being reviewed/fixed stays "building" mid-turn.
//       - At a NEW prompt boundary: the build TURN has already ENDED, so a terminal
//         verdict is too strict — a real build that produced implementer output but
//         never recorded a clean reviewer+tester verdict (interrupted verification,
//         a role that skipped its Bash-heredoc digest, a multi-session resume) would
//         otherwise stay pinned in "building" FOREVER, and every maintenance follow-up
//         would bypass triage and burn a full senior role on a one-line fix. So at the
//         boundary, IMPLEMENTER OUTPUT (a frontend/backend digest) is sufficient: the
//         orchestrator got past planning and code was written. A complex follow-up
//         still re-engages the orchestrator via maintenance triage, so nothing is lost.
//   • no subagent currently in flight (never flip mid-orchestration) — relaxed at the
//     prompt boundary, where leftover pending claims are not in-flight work (see below)
//   • the codebase has real output (source-file count well past the new-project bar)

import { countSourceFiles } from '../../shared/detection';
import { anyRunProducedImplementerOutput, anyRunReachedTerminalVerdict, hasActiveRunClaims, isMaintenancePhase, markMaintenance } from '../../shared/state';

// Floor only — the terminal-verdict + no-active-claims guards already prove the
// orchestrator ran through review and settled. Comfortably above detectMode's
// `≤5 files = new-project` bar.
const MAINTENANCE_FILE_THRESHOLD = 15;

// Did the build settle enough to flip? `atPromptBoundary` widens the bar from a
// strict terminal verdict (reviewer APPROVED + tester TESTS_GREEN, or a shipper
// digest) to ALSO accept implementer output (a frontend/backend digest) — the
// build turn has ended, so a finished-but-unverified build must still settle to
// maintenance. Mid-turn keeps the strict verdict so a live build is never flipped
// mid-verification. Existence-only of a reviewer/tester digest would false-positive
// on a mid-fix-cycle pass, hence the verdict-aware reader for the terminal check.
function buildSettled(root: string, atPromptBoundary: boolean): boolean {
  if (anyRunReachedTerminalVerdict(root)) return true;
  return atPromptBoundary && anyRunProducedImplementerOutput(root);
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
    if (!buildSettled(root, !!opts.atPromptBoundary)) return false;
    if (!opts.atPromptBoundary && hasActiveRunClaims(root, state)) return false;
    if (countSourceFiles(root) <= MAINTENANCE_FILE_THRESHOLD) return false;
    return markMaintenance(root, opts.atPromptBoundary ? 'prompt-boundary' : 'heuristic');
  } catch {
    return false;
  }
}
