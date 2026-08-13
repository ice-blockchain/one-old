// src/runners/doctor/run-diagnostic-report.ts
// Human-readable rendering of RunDiagnosticProbe for `doctor --run <id>`.
// Printed to STDERR (see index.ts) so stdout stays parseable JSON for an
// agent while a human at a 2am terminal gets the answer to "why is this
// stuck" without cross-referencing agents.json, the claim files, run.json,
// and decisions.jsonl by hand.

import { doctorBundleCommand } from '../../shared/doctor-command';
import { bothRunRecordsRemedy } from '../../shared/run-settlement';
import { describeSettlementLegibility } from './run-diagnostic';
import type { ClaimDiagnostic, DenyTally, LedgerDiagnostic, LiveAgentDiagnostic, RunDiagnosticProbe } from './run-diagnostic';

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h${remMinutes}m` : `${hours}h`;
}

// The literal phrasing the work item asked for: "this agent is 40s into a
// 30s window", which is what actually tells an operator a timestamp is stale —
// a bare "recordedAt: 2026-08-04T..." forces the reader to do the subtraction
// AND remember the window by hand.
function windowLine(ageMs: number, windowMs: number, stale: boolean): string {
  const verdict = stale ? 'STALE' : 'live';
  return `${formatDuration(ageMs)} into a ${formatDuration(windowMs)} window — ${verdict}`;
}

function renderRegisteredAgents(agents: readonly LiveAgentDiagnostic[]): string[] {
  if (agents.length === 0) return ['  (none)'];
  return agents.map((agent) => {
    const replaced = agent.replaced ? ' [REPLACED]' : '';
    return `  - ${agent.role}: ${agent.agentId} — ${windowLine(agent.ageMs, agent.windowMs, agent.stale)}${replaced}`;
  });
}

function renderClaims(claims: readonly ClaimDiagnostic[]): string[] {
  if (claims.length === 0) return ['  (none)'];
  return claims.map((claim) => {
    const id = claim.claimId ? ` (${claim.claimId})` : '';
    return `  - [${claim.state}] ${claim.role}${id} — ${windowLine(claim.ageMs, claim.windowMs, claim.stale)}`;
  });
}

function renderLedger(ledger: LedgerDiagnostic, runId: string): string[] {
  const lines: string[] = [];
  if (!ledger.exists) {
    lines.push('  no run.json for this run id — the run was never minted (or the id is wrong)');
  } else {
    lines.push(`  raw:       status=${ledger.rawStatus ?? '(none)'} outcome=${ledger.rawOutcome ?? '(none)'}`);
    lines.push(`  effective: status=${ledger.effectiveStatus ?? '(none)'} outcome=${ledger.effectiveOutcome ?? '(none)'}`);
  }
  lines.push(`  canonical: status=${ledger.canonicalStatus
    ?? (ledger.canonicalLegibility === 'absent'
      ? '(no settlement-v2.json — legacy/V1 run)'
      : `ILLEGIBLE [${ledger.canonicalLegibility}] — ${describeSettlementLegibility(ledger)}`)}`
    + (ledger.canonicalReason ? ` reason=${ledger.canonicalReason}` : ''));
  if (ledger.exists) {
    lines.push(`  qaContractVersion=${ledger.qaContractVersion ?? '(none)'} statusUpdatedAt=${ledger.statusUpdatedAt ?? '(none)'}`);
  }
  if (ledger.canonicalQuarantinePath) {
    lines.push(`  preserved: the damaged bytes were moved aside to ${ledger.canonicalQuarantinePath} before the`);
    lines.push('             record was rebuilt — nothing was destroyed, and that file is what to read to see');
    lines.push('             what the record used to claim.');
  }
  if (ledger.canonicalIllegibleOnce) {
    lines.push('  ⚠ This run\'s canonical settlement was found DAMAGED at least once. The run stays drivable and');
    lines.push('    can still settle failed/blocked and be reset, but it can never certify as verified/shipped:');
    lines.push('    nothing on disk can now say what the record used to claim. Start a fresh run for work that');
    lines.push('    needs to certify.');
  }
  if (ledger.canonicalLegibility !== 'ok' && ledger.canonicalLegibility !== 'absent') {
    lines.push(`  ⚠ ${bothRunRecordsRemedy(runId)}`);
  }
  if (ledger.rollbackBarrierNote) lines.push(`  ⚠ ${ledger.rollbackBarrierNote}`);
  return lines;
}

function renderTopDenies(denies: readonly DenyTally[]): string[] {
  if (denies.length === 0) return ['  (no denies recorded)'];
  return denies.map((entry, index) => {
    const unrecognized = entry.recognized ? '' : ' [UNRECOGNIZED denyId — build/version skew?]';
    const gates = entry.gateIds.length ? ` via ${entry.gateIds.join(', ')}` : '';
    return `  ${index + 1}. ${entry.denyId} ×${entry.count}${gates} (last ${entry.lastSeenAt})${unrecognized}`;
  });
}

export function formatRunDiagnosticReport(diagnostic: RunDiagnosticProbe): string {
  const lines: string[] = [];
  lines.push(`=== Traffic One doctor: run ${diagnostic.runId} ===`);
  if (!diagnostic.runDirExists) {
    lines.push('');
    lines.push(`No .traffic-one/runs/${diagnostic.runId}/ directory exists — this run id was never minted, or the`);
    lines.push('project root doctor resolved does not match the one the run lives under.');
    return lines.join('\n');
  }
  const staleAgents = diagnostic.liveAgents.filter((agent) => agent.stale);
  const staleClaims = diagnostic.claims.filter((claim) => claim.stale);
  const liveAgents = diagnostic.liveAgents.length - staleAgents.length;
  lines.push('');
  // "Live agents" was a lie for exactly the rows an operator is reading this
  // report to find: the list is the whole REGISTRY, stale entries included, and
  // each row already prints its own live/STALE verdict.
  lines.push(`Registered agents (${diagnostic.liveAgents.length}; ${liveAgents} live, ${staleAgents.length} stale):`);
  lines.push(...renderRegisteredAgents(diagnostic.liveAgents));
  lines.push('');
  lines.push(`Held claims (${diagnostic.claims.length}; ${staleClaims.length} stale):`);
  lines.push(...renderClaims(diagnostic.claims));
  lines.push('');
  lines.push('Run ledger:');
  lines.push(...renderLedger(diagnostic.ledger, diagnostic.runId));
  lines.push('');
  lines.push(`Decision log: ${diagnostic.decisionCount} decisions, ${diagnostic.denyCount} denies (${diagnostic.decisionLogPath})`);
  lines.push('Top repeated deny ids:');
  lines.push(...renderTopDenies(diagnostic.topDenies));
  lines.push('');
  lines.push(...renderNextStep(diagnostic, staleAgents.length + staleClaims.length, liveAgents));
  return lines.join('\n');
}

// Naming a cause and stopping there is half a diagnosis: an operator at 2am
// still has to guess whether to wait, re-prompt, or go read four state files.
// So this prescribes the least-destructive recovery that actually applies to
// the shape observed, and says plainly when the answer is "wait" — which is
// also a next step.
//
// Every branch below stays inside the read-only half of doctor. `--unblock`
// now exists (runners/doctor/unblock.ts) and is deliberately NOT prescribed
// here: nothing this function diagnoses — a stale claim, an idle run, a
// terminal ledger — is a gate refusing a call, so an override would relax
// enforcement without touching the cause, while permanently costing the run
// its verified/shipped eligibility. The override is offered by the refusal
// that it would actually lift (core/pipeline.ts), and nowhere else.
function renderNextStep(
  diagnostic: RunDiagnosticProbe,
  staleCount: number,
  liveAgents: number,
): string[] {
  const lines: string[] = ['Next step:'];
  const terminal = diagnostic.ledger.canonicalStatus
    ? ['verified', 'failed', 'blocked'].includes(diagnostic.ledger.canonicalStatus)
    : ['completed', 'failed', 'blocked'].includes(diagnostic.ledger.effectiveStatus ?? '');
  if (staleCount > 0) {
    lines.push(`  ${staleCount} agent(s)/claim(s) are past their liveness window — the likely cause of the wedge.`);
    lines.push('  1. Confirm those agent processes are actually gone (the window expiring is evidence, not proof).');
    lines.push('  2. Re-prompt the parent agent in this project ("continue"): the runtime reclaims an expired');
    lines.push('     claim on the next claim attempt for that role, and the parent re-drives the run.');
    lines.push('  3. Do NOT hand-edit run.json, agents.json, or the claim files — doctor deliberately does not,');
    lines.push('     and a half-repaired ledger is harder to diagnose than a stalled one.');
  } else if (!terminal && liveAgents === 0) {
    lines.push('  The run is not terminal and nothing is alive to advance it. Re-prompt the parent agent in this');
    lines.push('  project ("continue") so the run is re-driven from its recorded state.');
  } else if (!terminal) {
    lines.push(`  ${liveAgents} agent(s) are inside their liveness window — work is in flight. Wait for it, or read`);
    lines.push(`  the decision log (${diagnostic.decisionLogPath}) to see what it is repeating on.`);
  } else {
    lines.push(`  The run reached a terminal state (${diagnostic.ledger.canonicalStatus ?? diagnostic.ledger.effectiveStatus}); nothing here needs recovery.`);
    lines.push('  Start a new run rather than reopening this one.');
  }
  if (diagnostic.topDenies.some((deny) => !deny.recognized)) {
    lines.push('  At least one recorded denyId is unknown to this build — the run was driven by a different plugin');
    lines.push('  version. Update/reinstall the plugin before trusting the rest of this report.');
  }
  // The full command, interpolated — not `doctor --run <id> --bundle`, which
  // named no interpreter and no path, and which nothing in this product ever
  // puts on PATH (the shim is `doctor.cjs` under the runner-shim dir, never a
  // bare `doctor`). It was printed at the exact moment a run is wedged, so an
  // operator who pasted it got "command not found" and, had they guessed the
  // path, a gate deny. doctorBundleCommand() is derived from the same constants
  // the doctor gate exemption is (shared/doctor-command.ts), so what this
  // prints is accepted by construction.
  lines.push(`  Attach machine-readable state to a bug report: ${doctorBundleCommand(diagnostic.runId)}`);
  lines.push('  (state only — no source and no prompt text; secrets are redacted best-effort, so read it');
  lines.push('  before sharing — see the bundle\'s own redaction.policy).');
  return lines;
}
