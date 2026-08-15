// src/shared/override/index.ts
// The consumer-facing half of the operator override: the ONE predicate that
// decides whether a refusal is overridable at all, the command a deny prints,
// and the lookup a gate does. Everything below is READ-ONLY — nothing in this
// module or its callers in core/pipeline.ts writes a token, touches the ledger,
// or records that a token fired. Minting lives in runners/doctor/unblock.ts,
// behind a confirmation this side cannot reach.
//
// ── Why one predicate ────────────────────────────────────────────────────────
// The plan's requirement is "every tier-1 deny prints the exact command for its
// own gate", with the anti-requirement "do not print an override command on a
// deny that cannot be overridden, which would be a lie the user acts on". Two
// separate rules — one deciding what to print, one deciding what to honour —
// satisfy that only for as long as nobody edits one of them. So there is one:
// `overridableDeny()` below is asked by the printer AND by the lookup, which
// makes "we never print a command that would not work" structural.
//
// ── What "tier-1" resolves to ────────────────────────────────────────────────
// The plan names a tier the code does not define, so it is derived here from
// distinctions the codebase ALREADY makes, rather than a new taxonomy:
//
//   1. PreToolUse only. core/pipeline.ts's own decisionKind() says it: "
//      PreToolUse is the only event whose job is literally 'may this tool call
//      proceed?'". A deny on Stop/UserPromptSubmit/SubagentStop re-prompts or
//      annotates; it does not stop a tool call, so there is nothing wedged for
//      an operator to unwedge, and offering an override there would be an
//      invitation with no failure behind it.
//   2. Not `askUser`. config/deny-ids.ts and core/result.ts both already state
//      that an approval prompt is not a refusal ("the human is the rate limit").
//   3. Not in NEVER_OVERRIDABLE_DENY_IDS (config/deny-ids.ts) — the single
//      shared list, also destined for the deny budget.
//
// Everything left is a hard block on the agent's work that an operator can
// legitimately lift, which is what tier-1 has to mean for this feature to be
// coherent: the set that prints the command and the set the token works on are
// the same set.

import type { CanonicalEvent } from '../../core/types';
import { isOverridableDenyId } from '../../config/deny-ids';
import { doctorShimCommand, isDoctorIdArgument } from '../doctor-command';
import { activeOverrideToken, runOverrideRecords, type OverrideToken } from './token';

export {
  OVERRIDE_DEFAULT_TTL_MS,
  OVERRIDE_MAX_TTL_MS,
  // The scope-generic lookup, exported for the future evidence waiver (scope
  // 'evidence'), which has no deny to hang `overrideForDeny` off.
  activeOverrideToken,
  mintOverride,
  overrideLedgerDigest,
  overrideLedgerIllegible,
  parseOverrideTtl,
  readOverrideLedger,
  readOverrideLedgerResult,
  runOverrideRecords,
  unvouchableOverrideEntries,
  vouchableMintIds,
  vouchableOverrideEntries,
} from './token';
export type {
  MintOverrideInput,
  MintOverrideResult,
  OverrideEntry,
  OverrideEntryOutcome,
  OverrideLedgerKind,
  OverrideLedgerRead,
  OverrideScope,
  OverrideToken,
} from './token';
export { OVERRIDE_DIR_NAME, overrideLedgerPath, overrideRoot, overrideSnapshotDir } from './paths';
// The completeness half of the primitive: whether the record can still account
// for itself. Read by settlement (never by a gate) and by the doctor probe.
export {
  OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK,
  OVERRIDE_LEDGER_ILLEGIBLE_CHECK,
  OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK,
  OVERRIDE_MINT_COUNT_MISMATCH_CHECK,
  OVERRIDE_SNAPSHOT_ORPHANED_CHECK,
  OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK,
  overrideEvidenceChecks,
  overrideEvidenceReport,
  overrideReconciliationDraft,
} from './integrity';
export type { OverrideEvidenceReport, OverrideReconciliationDraft } from './integrity';
export { readOverrideMintCounter } from './mint-counter';
export type { OverrideMintCounterRead, OverrideMintCounterState } from './mint-counter';
export type { OrphanSnapshot } from './snapshots';
// The named, append-only repair for a record that cannot account for itself.
// Minted by the doctor's operator command; consulted by settlement for the
// run quarantine that is what makes the repair safe to grant.
export {
  MAX_QUARANTINED_RUNS,
  OVERRIDE_RECONCILE_SECTION,
  readOverrideReconciliations,
  reconciliationRef,
  recordOverrideReconciliation,
  runQuarantinedByOverrideReconciliation,
} from './reconcile';
export type {
  OverrideAcknowledgement,
  OverrideReconciliation,
  RecordReconciliationResult,
} from './reconcile';

export interface OverridableDenyInput {
  readonly event: CanonicalEvent;
  readonly denyId: string | undefined;
  readonly askUser?: boolean;
}

/** The single tier-1 predicate. See this module's header for each conjunct. */
export function overridableDeny(input: OverridableDenyInput): boolean {
  if (input.event !== 'PreToolUse') return false;
  if (input.askUser) return false;
  return isOverridableDenyId(input.denyId);
}

/**
 * The exact command, runnable as printed — the same derivation
 * run-diagnostic-report.ts uses for its bundle line, and for the same reason:
 * an interpolated command that this product's own grammar or CLI would reject
 * is worse than no command, because the reader acts on it.
 *
 * `doctorShimCommand()` (the version-stable `~/.traffic-one/bin/doctor.cjs`
 * spelling), not the plugin-root one — a stuck operator may be reading this
 * days later, across a plugin bump.
 *
 * Returns '' for an id outside the argv grammar's charset, which is also the
 * only way this can decline: `isDoctorIdArgument` is doctor's own id shape, so
 * what is printed here is what `--unblock` will parse.
 */
export function unblockCommand(gateId: string, runId: string | null): string {
  if (!gateId || !isDoctorIdArgument(gateId)) return '';
  const run = runId && isDoctorIdArgument(runId) ? ` --run ${runId}` : '';
  return `${doctorShimCommand()} --unblock ${gateId}${run}`;
}

/**
 * The line appended to a tier-1 deny. One line, because it rides on EVERY such
 * refusal — the same budget the correlation ref already spends — and because a
 * paragraph here trains an agent to treat the override as a step in the loop.
 *
 * Addressed to the human on purpose ("you, in your own terminal"): an agent
 * that runs this from an ordinary tool call gets refused — the mint wants a TTY
 * a piped tool call does not have — and the sentence has to make that
 * predictable rather than a surprise. It is a cost, not a boundary (see
 * runners/doctor/unblock.ts's header on what a pty makes possible), which is
 * why the ineligibility consequence is stated in the same breath as the
 * command: that is the half that holds either way, and this is the only moment
 * anyone reads it. The pipeline does NOT append this string to hook denies:
 * Claude Code paints that reason as a user-visible Error, and advertising the
 * hatch there is what its Gate blocker UI promotes to Recommended.
 */
export function operatorOverrideHint(
  input: OverridableDenyInput & { readonly gateId: string; readonly runId: string | null },
): string {
  if (!overridableDeny(input)) return '';
  const command = unblockCommand(input.gateId, input.runId);
  if (!command) return '';
  return `\n\nStuck on this specific refusal? A human (not the agent) can lift it for 30m from their own`
    + ` terminal: \`${command}\` — the run is then permanently ineligible for verified/shipped.`;
}

/**
 * The live token that lifts THIS deny, or null. Called by core/pipeline.ts on
 * the deny path only.
 *
 * Not memoized, and it does not need to be: the pipeline short-circuits on its
 * first un-overridden deny, so this reads one small file at most once per
 * refusal — and on the overwhelmingly common path (no override was ever minted
 * for this project) that read is a single failed `stat`. Nothing on the ALLOW
 * path touches this module at all.
 */
export function overrideForDeny(
  projectRoot: string,
  runId: string | null,
  gateId: string,
  input: OverridableDenyInput,
  env: NodeJS.ProcessEnv = process.env,
): OverrideToken | null {
  if (!overridableDeny(input)) return null;
  return activeOverrideToken(projectRoot, runId, 'gate', gateId, env);
}

/** The agent-facing note left where the deny would have been. Names the token
 *  id so the audit line, the snapshot and this turn are one traceable event. */
export function overrideAppliedNotice(token: OverrideToken, gateId: string, denyId: string): string {
  return `traffic-one — OPERATOR OVERRIDE ACTIVE: gate \`${gateId}\` refused this call (\`${denyId}\`)`
    + ` and an operator override minted for run \`${token.runId}\` is letting it through`
    + ` (token \`${token.id}\`, expires ${token.expiresAt}).`
    + ' This run can no longer settle as verified or shipped. Do not treat the override as approval of the'
    + ' work — fix the underlying cause, and say in your digest that a gate was overridden.';
}

/**
 * Did this run ever have an override minted for it? The abuse guard, consulted
 * by run-settlement/io.ts. Deliberately TTL-blind — see runOverrideRecords.
 *
 * Answers only what the ledger SHOWS, and `false` therefore covers both "no
 * override" and "the line naming one is gone". Its companion
 * `overrideEvidenceChecks` (integrity.ts) is what refuses the second case;
 * settlement asks both, in that order, because a mint we can still see deserves
 * the specific `operator-override-used` reason rather than a generic one about
 * the record being incomplete.
 */
export function runUsedOperatorOverride(
  projectRoot: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOverrideRecords(projectRoot, runId, env).length > 0;
}
