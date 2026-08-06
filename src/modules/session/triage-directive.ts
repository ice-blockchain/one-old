// src/modules/session/triage-directive.ts
// Post-build maintenance triage directive, shared by TWO emitters:
//   1. UserPromptSubmit (prompt-submit.ts) — every edit-like prompt in
//      maintenance phase, and
//   2. the onboarding-wait runner — the SETUP-COMPLETE continuation. The agent
//      resumes the user's original request inside the SAME turn after the
//      wizard finishes, so no UserPromptSubmit ever fires for that request;
//      without this emission the routing rubric (quick-fix / single role /
//      orchestrator, OpenCode-first) is never injected and the agent freelances
//      the implementation inline.
// Returns the directive string, or '' when triage does not apply. Guards: must
// be maintenance phase, a coding/implementation prompt (skip questions/chat),
// not a subagent session, and no orchestration run currently in flight.

import { detectMode, isLikelyEditRequest, isRuntimeControlPrompt } from '../../shared/detection';
import { canonicalHost } from '../../shared/model-tiers';
import { currentModelForTier } from '../../shared/current-model-tiers';
import { hostFlags } from '../../shared/host/capability-flags';
import { detectHostPlan } from '../../shared/host/plan';
import { obj, type Rec } from '../../shared/obj';
import { firstEmitThisSession } from '../../shared/once';
import { pluginRoot } from '../../shared/paths';
import { openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { ensureRunModelPolicy, runBootstrapBlocked } from '../../shared/run-model-policy';
import { makeSkillBlock } from '../../shared/skill-block';
import {
  ensureRunLedger,
  hasActiveRunClaims,
  hookSessionIdentity,
  isSubagentThread,
  isMaintenancePhase,
  lifecycleCompletedAt,
  readState,
  releaseRunClaims,
  runHasOrchestratedArtifacts,
  runIdNow,
  runIsEmptyFailedHusk,
  runSettledForRotation,
  runVerificationState,
  settleTerminalRunLedger,
  stackFingerprint,
  transitionRunStatus,
  writeState,
} from '../../shared/state';
import { classifyPromptComplexity } from '../../shared/triage/classify';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

function isExplicitRunResumePrompt(promptText: string): boolean {
  return /^\s*(?:(?:please|ok(?:ay)?|yes)[,\s]+)*(?:continue|resume|proceed|retry|try\s+again)(?:\s+(?:the|this|that|same))?(?:\s+(?:run|work|verification|tests?|review|cycle))?\s*[.!]?\s*$/i
    .test(promptText);
}

/**
 * Rotate the maintenance run id, reporting whether `state.currentRunId` still
 * names a run `.one.json` also names.
 *
 * `false` has exactly one cause: the rotation write was REFUSED — an unanswered
 * consent question, or a planted symlink at `.traffic-one/.one.json` — so the id
 * this call minted lives only in this process. Deliberately NOT the same list as
 * "everything that can stop the write": fsjson.ts's `act` answers `false` only
 * for the consent/path guard and ELOOP and RETHROWS every other errno, so an
 * EACCES leaves through an exception, which core/pipeline.ts converts into the
 * fail-closed `pipeline-handler-crashed` deny. See the errno case in
 * __tests__/triage-rotation-refusal.test.ts. `true` covers a completed
 * rotation AND a deliberate non-rotation (a LIVE run stays pinned) — in both,
 * memory and disk agree, which is the only thing a caller can act on.
 *
 * The write moved AHEAD of the ledger settlement and the claim release, and that
 * ordering IS the fix rather than a tidy-up: those two dismantle the OUTGOING
 * run, and they are only correct because `.one.json` now names a different one.
 * With the write last, a refusal left `.one.json` naming a run whose claims had
 * just been released and whose ledger had just been settled terminal, while this
 * process carried on under an id nothing on disk knew — so the routing directive
 * handed the agent, and `opencode_delegate`, a run every gate resolves
 * differently, and a ledger plus a create-once model policy were opened under it.
 * Same shape and same remedy as run-agent/identity-drift.ts's
 * re-point-before-release.
 *
 * Exported for the run-sim tier, which drives a real second run in the same
 * project. A replica in the test would drift from this; calling it is the point.
 */
export function beginFreshMaintenanceRun(cwd: string, state: Rec, host: string): boolean {
  // Never rotate while the CURRENT run is still LIVE: it has run artifacts
  // (assignments/digests) but has NOT reached a terminal verdict. Rotating then would
  // split run state across two ids — the run-id gate resolves no scope for the in-flight
  // role spawns ("subagents couldn't start"). "Terminal" is per-run (this run's reviewer
  // APPROVED + tester passed, or a shipper digest), so a SETTLED run rotates and a LIVE one
  // (incl. a 2nd maintenance feature mid-fix-cycle) does not. NOTE: we deliberately do NOT
  // treat `lifecycle.source==='orchestrator'` as "settled" — that stamp is written once at
  // the first build's completion and never reset, so it stays true for the project's life
  // and would wrongly green-light rotating a LATER mid-verification run. The artifact check
  // is SCHEMA-AGNOSTIC (raw existence) so a non-conforming manifest can't defeat it. A plain
  // maintenance edit with no orchestrated run still rotates (the common per-prompt case).
  const current = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  // Rotate only when the run's contract allows it. qaContractVersion:1 runs require
  // strict reviewer + tester + QA terminal settlement; the state helper retains the
  // historical green-verdict compatibility only for legacy runs. A LIVE run does not
  // rotate, preserving currentRunId and its role agents for continuation.
  if (current && runHasOrchestratedArtifacts(cwd, current) && !runSettledForRotation(cwd, current)) return true;
  const runId = runIdNow();
  const sharedState = readState(cwd);
  const rotatedState = { ...sharedState, currentRunId: runId, spawnIndex: {} };
  const rotated = writeState(cwd, rotatedState);
  // Nothing below may run over a refused rotation: every one of them is either
  // irreversible (dismantling the outgoing run) or opens run-scoped state under
  // an id `.one.json` does not carry (the ledger, and a model policy that is
  // create-once and therefore unrepairable in place). Leaving the previous run
  // wholly intact is the only outcome the next hook can read consistently.
  if (!rotated) return rotated;
  if (current) {
    // The outgoing run is settled (or produced nothing): finalize its ledger
    // (evidence-gated no-op when unproven) and release its agent claims so the
    // rotated-away run never counts as in-flight again.
    settleTerminalRunLedger(cwd, current);
    releaseRunClaims(cwd, current, 'run-rotated');
  }
  ensureRunLedger(cwd, runId, { status: 'planned', kind: 'maintenance-triage', stackFingerprint: stackFingerprint(rotatedState) });
  // Freeze this maintenance run's model policy at mint, exactly as the build run
  // does in the onboarding-gate spawn preflight. Without it the FIRST followup_task
  // to a retained implementer thread is denied ("run's model policy not materialized
  // yet") because only a spawn preflight — not a followup — would otherwise create it
  // (observed 11c). Use the MERGED `state` (not the prefs-stripped `sharedState`):
  // buildRunModelPolicy reads the performance level, which readState strips as a
  // host pref. Best-effort — if the catalog can't be frozen the existing model-policy
  // deny still fires later, no worse than today; a freeze failure must never break
  // triage (which must always return its routing directive).
  try {
    ensureRunModelPolicy(cwd, runId, host, { ...state, currentRunId: runId }, { ...process.env, TRAFFIC_ONE_HOST: host });
  } catch { /* best-effort freeze; the deny path still covers a missing policy */ }
  state.currentRunId = runId;
  state.spawnIndex = {};
  return rotated;
}

// Prompt-boundary recovery for a run whose verification has started but has not
// reached its complete terminal combination. This is intentionally separate from
// maintenance complexity triage: it preserves the current run and its existing role
// agents instead of minting a greenfield/quick-fix flow. Runtime control remains
// parent-only and receives no worker directive at all.
export function unresolvedRunDirective(cwd: string, state: Rec, promptText: string, raw: unknown): string {
  if (isSubagentThread(raw) || isRuntimeControlPrompt(promptText)) return '';
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId || runVerificationState(cwd, runId) !== 'nonterminal') return '';
  // A `failed` ledger reads as 'nonterminal' above (an agent failure IS
  // unresolved), so without this an EMPTY failed run captured every later
  // prompt: this directive won at the caller's `unresolved || triage`, so
  // maintenance triage — the only path that mints a fresh run id — never ran,
  // and the resume branch below cannot reopen `failed` either. The project
  // stayed wedged across sessions with nothing to continue. Fall through to
  // triage so the husk is replaced; a failed run holding real work still routes
  // here, because artifacts or live claims disqualify it.
  if (runIsEmptyFailedHusk(cwd, runId)) return '';
  const explicitResume = isExplicitRunResumePrompt(promptText);
  if (explicitResume) {
    // A capped/environment-blocked run may resume only after the user explicitly
    // authorizes another cycle. This exact transition reason is the ledger's
    // machine-verifiable authorization; it also activates/upgrades legacy runs.
    const resumed = transitionRunStatus(cwd, runId, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
      kind: 'unresolved-resume',
      stackFingerprint: stackFingerprint(state),
    });
    // A resume that did NOT take effect must not read as one. Observed 10co: the
    // ledger recorded the authorization while the canonical settlement stayed
    // blocked, so the orchestrator spawned a fix cycle into a run whose every
    // NEW child was denied its role claim for the rest of the session. Say so
    // instead of emitting the ordinary continue directive.
    if (!resumed) {
      return [
        `[TRAFFIC ONE RUN "${runId}" COULD NOT BE RESUMED]`,
        `The user-authorized resume did not take effect: \`.traffic-one/runs/${runId}/settlement-v2.json\` did not reach \`"status": "active"\`.`,
        'Do NOT spawn or replace child agents in this run — a new child cannot bind a role in it, so every one of its tool calls will be denied.',
        'Report the blocked settlement to the user and settle this run before starting another cycle.',
      ].join('\n');
    }
  } else if (isLikelyEditRequest(promptText)) {
    // This prompt is resuming implementation/verification, not merely asking for
    // status. Activate the existing ledger so a legacy run upgrades to QaReportV1;
    // blocked ledgers remain blocked until an explicit authorized-resume prompt.
    ensureRunLedger(cwd, runId, {
      status: 'active',
      kind: 'unresolved-resume',
      stackFingerprint: stackFingerprint(state),
    });
  }
  return [
    `[UNRESOLVED TRAFFIC ONE RUN — continue run "${runId}"]`,
    'Verification has started but has not reached the terminal reviewer + tester + QA combination.',
    'Preserve currentRunId and the existing role-agent continuations. Inspect this run\'s reviewer, tester, and QA evidence; continue the same verifier/fix loop when implementation work is requested.',
    'Do not create or rotate a run, start a greenfield architect flow, invoke OpenCode, spawn a quick-fix agent, stamp maintenance, or advertise shipping.',
    'For a status/read-only question, answer from the existing artifacts. If the run is capped or environment-blocked, use the blocked summary and state the exact user decision required.',
  ].join('\n');
}

// Once the main build is complete (existing codebases from the start; new
// projects once the build flips them to maintenance) the machinery should scale
// to the request rather than treating every prompt the same: trivial → a
// cheap/OpenCode quick-fix, small → a single role, complex → re-engage the
// orchestrator. Hooks can't classify with an LLM, so we inject a compact
// directive plus a deterministic keyword hint and let the agent decide. The
// directive branches on team mode so it never promises a subagent that
// main-agent mode can't spawn.
export function maintenanceTriageDirective(cwd: string, state: Rec, promptText: string, raw: unknown, host: string): string {
  const mode = (state.mode as string) || detectMode(cwd);
  if (!isMaintenancePhase(state, mode)) return '';
  // Runtime-only commands stay with the parent. This check intentionally lives in
  // maintenance/unresolved routing rather than the general coding-intent classifier:
  // "restart the dev server" must not mint a run or spawn a quick-fix worker, while
  // "fix the server startup error" still follows ordinary implementation routing.
  if (isRuntimeControlPrompt(promptText)) return '';
  // Broader than the onboarding coding-intent gate: a finished app's copy/UI tweaks
  // ("change the hero headline", "shorten the title") must still route through triage.
  if (!isLikelyEditRequest(promptText)) return '';
  if (isSubagentThread(raw)) return '';
  // Claims from a run that finished BEFORE the lifecycle stamp are settled —
  // only claims newer than the watermark mean an orchestration is in flight.
  //
  // Kilo is the one host that does not expose a task-completion/resume lifecycle
  // to this plugin. Its built-in `general` task can leave a stale fresh `claimed`
  // record behind after the parent has received the reply, so a new Kilo message
  // may bypass claim suppression. The run-rotation guard remains authoritative,
  // though: an artifact-bearing nonterminal run keeps currentRunId so unresolved
  // verification is never replaced with a greenfield maintenance run.
  const kiloPromptBoundary = hostFlags(canonicalHost(host)).noTaskCompletionLifecycle;
  if (hasActiveRunClaims(cwd, state, { since: lifecycleCompletedAt(state) }) && !kiloPromptBoundary) return '';

  const hint = classifyPromptComplexity(promptText);
  const teamMode = resolvedTeamMode(state);
  const signals = hint.signals.length ? ` — signals: ${hint.signals.join(', ')}` : '';
  // A rotation the fence refused must not be routed into: the rubric and the
  // `opencode_delegate` reminder below both NAME a run id, and the id this
  // process would name is one no gate can resolve. Refused before the
  // once-marker burn, for the same reason the bootstrap refusal is.
  if (teamMode === 'subagents' && !beginFreshMaintenanceRun(cwd, state, host)) {
    return rotationRefusedRefusal(state);
  }
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  // The refusal is evaluated AFTER rotation (the escape hatch has already been
  // written to disk, so it can never be suppressed) and BEFORE the once-marker
  // burn below — an agent that only ever received the refusal must still get
  // the FULL rubric once the run is usable, never a reminder pointing at prose
  // it has never seen.
  const refusal = bootstrapBlockedRefusal(cwd, state, host);
  if (refusal) return refusal;
  const ocActive = openCodeDelegationActive(state, host);
  // The rubric is ~95% static prose: inject it in full once per session, then a
  // one-line reminder with the per-prompt variables (tier hint + fresh runId).
  // beginFreshMaintenanceRun above still runs on every triage prompt.
  if (!firstEmitThisSession(cwd, 'maintenance-triage', hookSessionIdentity(raw).sessionId)) {
    const ocReminder = ocActive && teamMode === 'subagents'
      ? ` OpenCode runId for \`opencode_delegate\`: "${runId}".`
      : '';
    return `[MAINTENANCE PHASE — triage reminder] hint: ${hint.tier} (confidence ${hint.confidence})${signals} — route per the maintenance-triage rubric from earlier in this session (full rubric: \`task-triage\` skill).${ocReminder}`;
  }
  return triageRoutingBlock(state, host, {
    HINT: hint.tier,
    CONFIDENCE: hint.confidence,
    SIGNALS: signals,
  });
}

// ── The run the routing would name was never written down ────────────────────
// The rotation write is the ONLY thing that makes a fresh maintenance run id
// real: every consumer that does not route through `ensureCurrentRunId` reads
// `currentRunId` straight off `.one.json` (the pipeline's decision correlation,
// plan-write's compiled-architecture lookup, codex-child-model, the doctor and
// run-status runners, isSubagentSession). So a refused rotation is the same
// two-hooks-one-turn contradiction as the 16co refusal below — this hook naming
// run B while every gate enforces run A — reached through the write fence rather
// than a frozen policy. `state.currentRunId` is still the previous run, which is
// the one on disk, so the message names IT rather than the id nobody kept.
function rotationRefusedRefusal(state: Rec): string {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  return [
    'TRAFFIC_ONE_RUN_ROTATION_REFUSED',
    'A fresh maintenance run could not be started: the project state write fence refused `.traffic-one/.one.json`, so the new run id was never recorded and this request has no run to route into.',
    runId
      ? `The project is still on run "${runId}" — the previous, already-settled run. Nothing about it was released or settled by this attempt, so it is intact, but it is not a run to start new work in.`
      : 'The project state names no run at all.',
    'Do NOT spawn a role subagent, do NOT call `opencode_delegate`, and do NOT start a quick-fix: a child would bind its claim to a run id the parent gates do not agree on.',
    'Report the refused path to the user. A planted symlink at `.traffic-one/.one.json` is the usual cause (the fence refuses writing through a link, dangling or not); restore it as a regular file, or if this project has not answered "use Traffic One here?" answer it, then retry the request.',
  ].join('\n');
}

// ── The run the routing would name is one the parent gates refuse ────────────
// 16co, 2026-08-02: SessionStart emitted TRAFFIC_ONE_MODEL_POLICY_BLOCKED ("Do
// not spawn a child") and the triage reminder handed the agent that same run id
// for `opencode_delegate` one second later. Two hooks, one turn, opposite
// instructions. The precondition is CREATE-ONCE: only a run whose model policy
// is already published is unrepairable in place, and a run whose preflight
// covers implementer roles is one with published `assignments.json` — exactly
// what makes the rotation guard PIN it. So only a pinned wedged run reaches
// this refusal; a rotated-away wedge got a fresh id and answers "not blocked".
// Scoped to the same `team.mode === 'subagents'` condition the gates use, so
// this never speaks for a main-agent project the gates would let through.
function bootstrapBlockedRefusal(cwd: string, state: Rec, host: string): string {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  if (resolvedTeamMode(state) !== 'subagents' || !runId) return '';
  if (!runBootstrapBlocked(cwd, runId, host, state)) return '';
  return [
    'TRAFFIC_ONE_BOOTSTRAP_BLOCKED',
    `Run "${runId}" is frozen (create-once) and Traffic One cannot bootstrap a child in it, so every parent tool call in this run is denied. There is nothing to route this request into.`,
    'Do NOT spawn a role subagent, do NOT call `opencode_delegate`, do NOT start a quick-fix, and do NOT rotate or replace the run. Do not redo onboarding and do not replace `model-policy.json`.',
    'Report the run id to the user and stop. The parent gate\'s own message for this run (SessionStart, or the first denied tool call) states the exact repair — do not invent a different one.',
  ].join('\n');
}

function resolvedTeamMode(state: Rec): string {
  const team = obj(state.team);
  const perf = obj(state.performance);
  const level = perf && typeof perf.level === 'string' ? perf.level : '';
  return team && (team.mode === 'main-agent' || team.mode === 'subagents')
    ? (team.mode as string)
    : teamModeForLevel(level);
}

// The full routing rubric for the ACTIVE team mode, with the per-prompt hint
// variables supplied by the caller (the prompt-boundary directive) or a
// judge-it-yourself substitute (the headless fallback below, which has no
// prompt text to classify).
function triageRoutingBlock(state: Rec, host: string, hintVars: Record<string, string>): string {
  const teamMode = resolvedTeamMode(state);
  // Name the active local snapshot's concrete cheapest model so the agent can
  // pass it on the quick-fix spawn without resolving a bundled indirection.
  const cheapest = currentModelForTier('cheapest', host, detectHostPlan(host)) || 'the cheapest model for this host';
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  const ocActive = openCodeDelegationActive(state, host);
  // Render the OpenCode instruction only when delegation is actually active, so an
  // off state doesn't leave a dead-branch clause a literal reader must evaluate.
  let openCodeClause = '';
  let quickFixOpenCodeClause = '';
  let smallOpenCodeClause = '';
  if (ocActive) {
    if (teamMode === 'main-agent') {
      openCodeClause = ` If you prefer, offload it via the \`opencode_delegate\` tool (role "quick-fix").`;
    } else {
      quickFixOpenCodeClause = ` OpenCode is active — call the \`opencode_delegate\` tool FIRST with role "quick-fix", runId "${runId}", projectRoot, the bounded task, and \`allowedFiles\` as EXACT file paths (globs and directories are rejected in maintenance); only if it declines, spawn the paid worker. If the host safety reviewer rejects the call but offers a user-approval path, ask the user once (it sends the task + relevant code to OpenCode's hosted model) and on approval re-call; otherwise use the paid fallback. If the tool is not exposed, say the opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback.`;
      smallOpenCodeClause = ` OpenCode is active — call the \`opencode_delegate\` tool FIRST for each chosen role ("senior-frontend" and/or "senior-backend"), using runId "${runId}", projectRoot, its bounded task, and \`allowedFiles\` as EXACT file paths — list every file you will create or modify; globs and directories are rejected in maintenance. Only if it declines, spawn that paid role subagent. If the host safety reviewer rejects the call but offers a user-approval path, ask the user once (it sends the task + relevant code to OpenCode's hosted model) and on approval re-call; otherwise use the paid fallback. If the tool is not exposed, say the opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback.`;
    }
  }
  const blockName = teamMode === 'main-agent' ? 'maintenance-triage-main-agent' : 'maintenance-triage-subagents';
  return `${block(blockName, {
    ...hintVars,
    CHEAPEST_MODEL: cheapest,
    OPENCODE_CLAUSE: openCodeClause,
    QUICK_FIX_OPENCODE_CLAUSE: quickFixOpenCodeClause,
    SMALL_OPENCODE_CLAUSE: smallOpenCodeClause,
  })}`;
}

// Headless sessions never fire UserPromptSubmit (`claude -p` — verified live:
// the ep-text-edit e2e transcript has SessionStart hook events and ZERO
// UserPromptSubmit events), so the prompt-boundary triage directive above is
// never delivered there and the parent improvises its routing blind. This
// fallback rides the FIRST mutating/spawn PreToolUse of a maintenance session
// instead (wired in the onboarding-gate handler): by the time a tool mutates,
// an interactive session's edit prompt would already have burned the
// 'maintenance-triage' once-marker — an unburned marker at mutation time IS
// the headless signature (or a chat-first session about to do work; the rubric
// is due either way). No prompt text exists here, so no classifier hint — the
// agent judges the tier of the request it is executing. Rotation is
// deliberately NOT performed: the run id is minted by the same handler's
// pre-mint, and rotating outside the prompt boundary would double-rotate
// interactive sessions.
export function maintenanceTriageFallbackDirective(cwd: string, state: Rec, raw: unknown, host: string): string {
  const mode = (state.mode as string) || detectMode(cwd);
  if (!isMaintenancePhase(state, mode)) return '';
  if (isSubagentThread(raw)) return '';
  // Same suppression as the prompt boundary: fresh claims newer than the
  // lifecycle watermark mean a worker is live — continuation owns the request.
  const kiloBoundary = hostFlags(canonicalHost(host)).noTaskCompletionLifecycle;
  if (hasActiveRunClaims(cwd, state, { since: lifecycleCompletedAt(state) }) && !kiloBoundary) return '';
  // A pinned wedged run must not be named for routing here either (the 16co
  // hazard), and the refusal precedes the marker burn for the same reason as
  // the prompt path: the full rubric is still owed once the run is usable.
  const refusal = bootstrapBlockedRefusal(cwd, state, host);
  if (refusal) return refusal;
  if (!firstEmitThisSession(cwd, 'maintenance-triage', hookSessionIdentity(raw).sessionId)) return '';
  return triageRoutingBlock(state, host, {
    HINT: 'unavailable in this session',
    CONFIDENCE: 'judge the tier yourself from the request',
    SIGNALS: '',
  });
}
