// src/modules/agent-model/converge.ts
// Materialization-completeness check + on-demand convergence for the spawn gate.
// Ported from isCompletedTrafficOneMaterialization + materializeProjectIfNeeded
// (gates.cjs / _helpers.cjs), using the ported materialize subsystem.

import { isKnownStack } from '../../shared/config';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { isMaterialized, readEffectiveState, stackFingerprint, stateVersion, writeState } from '../../shared/state';
import { nowIsoNoMs } from '../../shared/text';

type Rec = Record<string, unknown>;

// Back-compat alias: the canonical predicate now lives in shared/config.
const isKnownStackName = isKnownStack;

/**
 * Deliberately does NOT ask `materializedFromDifferentPluginBuild` — the term
 * every OTHER convergence point in the product now carries
 * (shared/materialize/converge.ts, modules/materialize/converge-from-write.ts,
 * modules/session/session-start-lib.ts). This is the one predicate of the four
 * that feeds a LIVE GATE, and the omission is the safe direction, not an
 * oversight to be tidied up later.
 *
 * WHY. Its only consumer is gate-enforcement.ts#modelEnforcementGates, whose
 * branch is `isNewProject && !isCompletedTrafficOneMaterialization(...)`, and
 * BOTH arms of that branch return a deny — one after `materializeIfNeeded`
 * repairs (`agent-materialization-deny`, "rerun the same spawn"), one when it
 * cannot (`agent-materialization-missing`). Entering the branch is therefore
 * unconditionally a refusal, so widening the entry condition is not "one more
 * freshness check", it is a new class of denied spawn.
 *
 * And the repair cannot clear a build mismatch against exactly the root state a
 * build change produces. `materializeProjectAssets` refuses a torn or partial
 * plugin root (`plugin-root-content-incomplete`, `plugin-root-unverified`) —
 * the state a marketplace sync leaves mid-flight, which is the same event that
 * moved the hash. On such a root the sweep returns `skipped`,
 * `materializeIfNeeded` answers `true` (nothing to record is not a refusal), the
 * manifest keeps the previous build's stamp, and the read-back would deny
 * `agent-materialization-missing` on EVERY spawn, forever, with `CAUSE` empty
 * because the stamp write was never refused. Its prose names
 * `materializedStack`/`materializedAt`/`materializedVersion` and five paths that
 * are all present and correct. A permanent refusal whose text describes a
 * condition that is false, in the one place a user cannot route around, is a
 * strictly worse outcome than one spawn running against the previous release's
 * rules — which is all the omission costs, and which the surrounding pipeline
 * closes within the same tool call (see below).
 *
 * THE ORDERING THIS RESTS ON — stated because an unstated one is what the next
 * reader breaks:
 *   - On cursor/copilot/opencode/kilo/windsurf a spawn's PreToolUse is ONE
 *     subcommand, so core/pipeline.ts runs onboarding-gate (module.json
 *     priority 10, `spawn-agent` in its tool set) before this gate (priority 40)
 *     in the same process, and onboarding-gate's `materializeProjectIfNeeded`
 *     DOES carry the term. A spawn is not `isMutatingPreToolUse`, so it attaches
 *     context rather than denying, and the pipeline reaches this gate with the
 *     project already converged. Structural: priority order, one process.
 *   - On claude/codex it does NOT hold. `check-onboarding-gate` and
 *     `check-agent-model` are separate manifest entries (gen/sources/hooks.ts)
 *     dispatched as separate processes with separate handler sets
 *     (core/dispatch.ts#handlersForSubcommand); nothing here orders them. What
 *     makes that harmless is not ordering at all — it is that this gate REPAIRS
 *     ITSELF at gate-enforcement.ts's `materializeIfNeeded` before choosing a
 *     deny. Adding the term here is what would make the missing order matter.
 *   - Every host does deliver a prompt event that reaches
 *     `materializeProjectIfNeeded` (claude/codex UserPromptSubmit, cursor
 *     beforeSubmitPrompt, copilot UserPromptSubmit, windsurf pre_user_prompt via
 *     the adapter's canonical mapping, opencode/kilo chat.message), but headless
 *     and subagent sessions fire none, so that is not the guarantee to lean on.
 */
export function isCompletedTrafficOneMaterialization(cwd: string, state: Rec): boolean {
  return Boolean(
    state
    && state.onboardingComplete === true
    && isKnownStackName(state.stack)
    && isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state),
  );
}

/**
 * Converge the project's `.traffic-one/**` assets, reporting whether the
 * materialization STAMP is now on disk.
 *
 * `false` has exactly one cause: the stamp write was REFUSED — an unanswered
 * consent question, or a planted symlink at `.traffic-one/.one.json`. Measured,
 * and not the same list as "everything that can stop the write": fsjson.ts's
 * `act` answers `false` only for the consent/path guard and ELOOP, and RETHROWS
 * every other errno, so an EACCES arrives here as an exception rather than as
 * `false`. Either way the assets exist and nothing on disk says so; only the
 * first arm is expressible as a return value. `true` covers a completed stamp
 * AND every path that had no stamp to write — an unknown stack, incomplete
 * onboarding, an already-materialized project, a skipped sweep.
 *
 * WHAT THE ANSWER IS FOR, since it deliberately does not decide the verdict.
 * The consumer (gate-enforcement.ts#modelEnforcementGates) reads back
 * `isCompletedTrafficOneMaterialization` against the state it re-reads from disk,
 * and that read-back stays authoritative — it is strictly stronger, because it
 * also catches a stamp that landed over incomplete assets, and an already-stamped
 * project whose assets were just restored under a refused re-stamp (there the
 * project IS complete and `false` here would misreport it). So this boolean names
 * the CAUSE, not the outcome: it is the only thing that can distinguish "did not
 * converge" from "converged and could not record it", and the second is
 * permanent — refusals through this layer are durable, so every later spawn
 * re-runs the whole sweep (~36 ms, ~90 rewritten files per call; 72.5, 34.8,
 * 37.3, 36.1, 36.0 ms over five consecutive calls on a default/react-vite
 * project) and denies again, forever, with nothing naming the refused path.
 *
 * Measured on a project whose `.one.json` was fenced move-aside: the assets land
 * (3 -> 93 files), no `materialized*` key reaches disk, the read-back answers
 * `false`, and the consumer denies `agent-materialization-missing` rather than
 * `agent-materialization-deny`. Both are denies and they are distinguishable, so
 * the run already failed closed on the correct one — this is a diagnosis fix, not
 * a fail-open fix.
 *
 * NOT the permanent-deny-loop consumer: that one is
 * shared/materialize/converge.ts's, whose caller reads any non-null outcome as
 * `repaired-materialization`, and it already reports the refusal
 * (stateWriteRefusedOutcome).
 *
 * WHAT THIS BOOLEAN ALSO CANNOT EXPRESS, since the list above was written when
 * the stamp refusal was the only such fact: the sweep below now also reports
 * `result.roleContracts` — the host's per-role contract files could not be
 * written — and this route reads only `result.skipped`, so it answers `true` for
 * a project that materialized everything EXCEPT the contracts that define the
 * role its caller is about to spawn.
 *
 * DELIBERATE, and the two reasons are worth stating because the shortfall is
 * real. First, this boolean is consumed as "did the stamp land", and its caller
 * turns anything falsy into one of two denies whose prose names
 * `materializedStack`/`materializedAt` and five paths — none of which is the
 * problem when a role directory is occupied, so folding the condition in here
 * would produce a permanent refusal describing a state that is false, which is
 * the exact defect the paragraphs above exist to avoid. Second, the condition is
 * already refused and disclosed where it is actionable and where its own cause
 * can be named: onboarding-gate/handler.ts denies file-changing work under
 * `host-role-contracts-unwritable` (a spawn is not a mutating tool use, so it is
 * not what that deny costs), the SessionStart banner states it to the
 * orchestrator, and the spawn directives that would otherwise hand a child a path
 * to a file that is not there check for it first
 * (plan-guard/build-orchestration-directive.ts,
 * runners/onboarding-wait/pre-spawn-directives.ts). The residual is a spawn on a
 * contract-less project running as a generic worker bound only by its
 * `[t1-role: …]` marker, which is the same posture as the built-in-fallback spawn
 * the spawn table already treats as legitimate.
 */
export function materializeIfNeeded(cwd: string): boolean {
  const state = readEffectiveState(cwd);
  if (!isKnownStackName(state.stack) || state.onboardingComplete !== true) return true;
  // No build-freshness term here either, and here it would be INERT rather than
  // harmful: the sole caller reaches this line only inside the branch above,
  // which is entered because `isCompletedTrafficOneMaterialization` already
  // answered false — so one of the two conditions on this line is already false
  // and the sweep below already runs, stamping the installed build's hash.
  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) return true;
  const result = materializeProjectAssets(cwd, state);
  if (result.skipped) return true;
  state.materializedStack = stackFingerprint(state);
  state.materializedAt = nowIsoNoMs();
  state.materializedVersion = stateVersion();
  return writeState(cwd, state);
}
