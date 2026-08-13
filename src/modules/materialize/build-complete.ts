// src/modules/materialize/build-complete.ts
// Guarded fallback that flips a finished new-project build to the "maintenance"
// lifecycle phase. The PRIMARY signal is the orchestrator's explicit Phase-5
// write (source: "orchestrator"); this heuristic is the safety net for an
// orchestrated build whose explicit signal never landed (interrupted after
// review, an older orchestrator). It is intentionally conservative — every guard
// must hold, so a still-building project is never misrouted to trivial handling:
//   • new-project + onboarding finalized (caller's responsibility)
//   • not already in maintenance
//   • the CURRENT build run settled — and what counts as "settled" depends on
//     WHEN we check:
//       - DURING a turn (PostToolUse): a TERMINAL verdict — reviewer `APPROVED` +
//         tester `TESTS_GREEN` (or a shipper digest). Mere EXISTENCE of a reviewer/
//         tester digest is NOT enough: the file is created when the role first runs
//         (Phase 3) and re-emitted on every fix-cycle pass, so a live review→fix→
//         re-review loop (verdict still `CHANGES_REQUESTED`/`TESTS_FAILING`) would
//         otherwise trip this path mid-verification. Requiring a terminal verdict
//         means a build still being reviewed/fixed stays "building" mid-turn.
//       - At a NEW prompt boundary: an implementer-only run (no verifier digest was
//         ever started) may use the historical interrupted-build fallback. The instant
//         either verifier has emitted a digest, however, the run is NONTERMINAL until
//         the complete reviewer + tester + QA gate passes. Requested changes, failing
//         tests, delegated-only output, partial verification, and blocked QA therefore
//         remain in `building` and keep the same currentRunId.
//   • no subagent currently in flight (never flip mid-orchestration) — relaxed at the
//     prompt boundary, where leftover pending claims are not in-flight work (see below)
//   • the codebase has real output (source-file count well past the new-project bar)

import * as fs from 'fs';
import * as path from 'path';

import { readRegularFile } from '../../shared/bounded-read';

import { scanSourceFiles } from '../../shared/detection';
import { sweepAfterTerminalSettlement } from '../../shared/retention';
import {
  hasActiveRunClaims,
  isMaintenancePhase,
  isNewProjectMode,
  markMaintenance,
  pruneExpiredPendingClaims,
  releaseRunClaims,
  runHasEnvironmentBlockedQaOutcome,
  runVerificationState,
  settleTerminalRunLedger,
  transitionRunStatus,
} from '../../shared/state';

// Floor only — the terminal-verdict + no-active-claims guards already prove the
// orchestrator ran through review and settled. Comfortably above detectMode's
// `≤5 files = new-project` bar.
const MAINTENANCE_FILE_THRESHOLD = 15;

function timestampForLegacyRun(root: string, runId: string): number {
  const ledger = path.join(root, '.traffic-one', 'runs', runId, 'run.json');
  // A generated 13-digit run id and the immutable ledger createdAt field are
  // creation signals. Prefer them over mutable settlement timestamps and file
  // mtimes: an old run can be reviewed, finished, or merely touched after a
  // newer unresolved run without becoming the current run again.
  const runIdCreatedAt = /^\d{13}$/.test(runId) ? Number(runId) : NaN;
  let ledgerCreatedAt = NaN;
  let newestFallback = 0;
  try {
    // BOUNDED (shared/bounded-read.ts). A non-regular object throws into the
    // catch below — the "legacy run has no ledger" arm this already falls
    // through for — rather than parsing the EOF an O_NONBLOCK FIFO returns into
    // a ledger with no timestamps, which would silently promote the run's
    // artifact mtimes over a `createdAt` that was never read.
    const text = readRegularFile(ledger);
    if (text === null) throw new Error(`not-a-regular-file: ${ledger}`);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    ledgerCreatedAt = typeof parsed.createdAt === 'string' ? Date.parse(parsed.createdAt) : NaN;
    for (const key of ['updatedAt', 'statusUpdatedAt', 'finishedAt']) {
      const at = typeof parsed[key] === 'string' ? Date.parse(parsed[key] as string) : NaN;
      if (Number.isFinite(at)) newestFallback = Math.max(newestFallback, at);
    }
  } catch {
    // Legacy runs often have no ledger; fall through to their artifact mtimes.
  }
  if (Number.isFinite(runIdCreatedAt)) return runIdCreatedAt;
  if (Number.isFinite(ledgerCreatedAt)) return ledgerCreatedAt;

  // Only runs with neither creation signal fall back to mutable timestamps.
  const candidates = [
    path.join(root, '.traffic-one', 'runs', runId),
    path.join(root, '.traffic-one', 'digests', runId),
  ];
  for (const dir of candidates) {
    try {
      newestFallback = Math.max(newestFallback, fs.statSync(dir).mtimeMs);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = path.join(dir, entry.name);
        newestFallback = Math.max(newestFallback, fs.statSync(file).mtimeMs);
      }
    } catch {
      // One side (runs or digests) may legitimately be absent.
    }
  }
  return newestFallback;
}

// Legacy projects can predate currentRunId. In that one compatibility case, inspect
// only the NEWEST known run rather than scanning for any old green verdict. Include
// runs/ as well as digests/ so a newer unresolved assignment cannot be hidden by an
// older terminal digest.
function newestLegacyRunId(root: string): string {
  const ids = new Set<string>();
  for (const kind of ['runs', 'digests']) {
    try {
      const base = path.join(root, '.traffic-one', kind);
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name) ids.add(entry.name);
      }
    } catch {
      // Missing state is equivalent to no candidate.
    }
  }
  let selected = '';
  let selectedAt = -1;
  for (const runId of ids) {
    const at = timestampForLegacyRun(root, runId);
    if (at > selectedAt || (at === selectedAt && runId > selected)) {
      selected = runId;
      selectedAt = at;
    }
  }
  return selected;
}

function currentRunId(state: unknown): string {
  if (!state || typeof state !== 'object') return '';
  const raw = (state as { currentRunId?: unknown }).currentRunId;
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw));
  return '';
}

// Did THIS build run settle enough to flip? Mid-turn requires strict terminal
// verification. At a prompt boundary, keep the old interrupted-build escape only
// for a run whose implementer wrote output but whose verification never started.
interface BuildSettlement {
  settled: boolean;
  terminal: boolean;
  runId: string;
}

function buildSettlement(root: string, state: unknown, atPromptBoundary: boolean): BuildSettlement {
  const runId = currentRunId(state) || newestLegacyRunId(root);
  if (!runId) return { settled: false, terminal: false, runId: '' };
  const verification = runVerificationState(root, runId);
  if (verification === 'terminal') {
    return { settled: true, terminal: true, runId };
  }
  if (atPromptBoundary && verification === 'nonterminal' && runHasEnvironmentBlockedQaOutcome(root, runId)) {
    // Release before settling — a terminal transition fails closed while claims
    // are still active, and nothing else releases them on the non-verified path.
    releaseRunClaims(root, runId, 'terminal-environment-blocked');
    if (transitionRunStatus(root, runId, { status: 'blocked', outcome: 'environment-blocked' })) {
      // The report is discarded DELIBERATELY, not overlooked: this is a hook path
      // whose only answer is "did the build flip to maintenance", and how much
      // disk cleanup reclaimed cannot change that. The sweep announces a refused
      // or failed reclaim on stderr itself, which is the only channel THIS
      // function has.
      //
      // That includes the report's `notices`. What this comment used to say about
      // them was false in the same way the census in shared/retention.ts was
      // before it was corrected: it claimed the caller has no banner to put them
      // in. It does. `buildSettlement` → `maybeFlipToMaintenance` has two
      // non-test callers, and BOTH compose user-visible context — VERIFIED, not
      // repeated: in session/prompt-submit.ts every exit path BELOW the call
      // site returns `context(...)`, the last of them unconditional, and
      // materialize/post-stack-setup.ts composes `context(...)` at six sites.
      // (The `noop()` returns in prompt-submit all sit ABOVE the call site, so
      // they are not exits this path can take.) A surface exists.
      //
      // The cost is DECLINED rather than absent, which is the honest version:
      // carrying a notice from here to either of them means widening two return
      // types — `BuildSettlement`, which answers three booleans and a run id, and
      // `maybeFlipToMaintenance`, which answers one boolean — so that a hook path
      // whose question is "did this flip" can also carry retention prose. That is
      // a real change to two signatures for a disclosure the user already gets:
      // SessionStart's advisory reports the same standing conditions on the same
      // project, and `traffic-one-cleanup` prints them on demand. Declined for
      // that reason. If either signature ever widens for its own reasons, thread
      // this through rather than re-deriving the argument.
      sweepAfterTerminalSettlement(root, runId);
    }
  }
  return {
    settled: atPromptBoundary && verification === 'not-started',
    terminal: false,
    runId,
  };
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
// maintenance request. So at the prompt boundary we skip that guard (the current-run
// verification state + file-count guards still prove implementation occurred). During
// a turn (PostToolUse) the guard stays, so a long/blocked build is never flipped
// mid-recovery.
export function maybeFlipToMaintenance(root: string, state: unknown, opts: { atPromptBoundary?: boolean } = {}): boolean {
  try {
    const mode = state && typeof state === 'object' ? (state as { mode?: unknown }).mode : undefined;
    if (!isNewProjectMode({ mode })) return false;
    if (isMaintenancePhase(state, 'new-project')) return false;
    const settlement = buildSettlement(root, state, !!opts.atPromptBoundary);
    if (!settlement.settled) return false;
    if (!opts.atPromptBoundary && hasActiveRunClaims(root, state)) return false;
    // Only the `<=` comparison is used, so the walk stops one file past the
    // threshold. Truncation needs no arm here: the count is a floor, so a
    // truncated count above the threshold is still above it, and a truncated
    // count below it leaves the build in `new-project` — the conservative side.
    if (scanSourceFiles(root, { stopAfter: MAINTENANCE_FILE_THRESHOLD }).count <= MAINTENANCE_FILE_THRESHOLD) return false;
    if (settlement.terminal && !settleTerminalRunLedger(root, settlement.runId)) return false;
    const flipped = markMaintenance(root, opts.atPromptBoundary ? 'prompt-boundary' : 'heuristic');
    if (flipped) pruneExpiredPendingClaims(root);
    return flipped;
  } catch {
    return false;
  }
}
