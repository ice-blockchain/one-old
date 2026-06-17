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

import { detectMode, isLikelyEditRequest } from '../../shared/detection';
import { resolveModel } from '../../shared/model-tiers';
import { obj, type Rec } from '../../shared/obj';
import { firstEmitThisSession } from '../../shared/once';
import { pluginRoot } from '../../shared/paths';
import { openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { makeSkillBlock } from '../../shared/skill-block';
import { hasActiveRunClaims, hookSessionIdentity, isMaintenancePhase, lifecycleCompletedAt, readState, runHasOrchestratedArtifacts, runIdNow, runReachedTerminalVerdict, writeState } from '../../shared/state';
import { classifyPromptComplexity } from '../../shared/triage/classify';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

function beginFreshMaintenanceRun(cwd: string, state: Rec): void {
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
  if (current && runHasOrchestratedArtifacts(cwd, current) && !runReachedTerminalVerdict(cwd, current)) return;
  const runId = runIdNow();
  const sharedState = readState(cwd);
  writeState(cwd, { ...sharedState, currentRunId: runId, spawnIndex: {} });
  state.currentRunId = runId;
  state.spawnIndex = {};
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
  // Broader than the onboarding coding-intent gate: a finished app's copy/UI tweaks
  // ("change the hero headline", "shorten the title") must still route through triage.
  if (!isLikelyEditRequest(promptText)) return '';
  if (hookSessionIdentity(raw).isSubagent) return '';
  // Claims from a run that finished BEFORE the lifecycle stamp are settled —
  // only claims newer than the watermark mean an orchestration is in flight.
  if (hasActiveRunClaims(cwd, state, { since: lifecycleCompletedAt(state) })) return '';

  const hint = classifyPromptComplexity(promptText);
  const team = obj(state.team);
  const perf = obj(state.performance);
  const level = perf && typeof perf.level === 'string' ? perf.level : '';
  const teamMode = team && (team.mode === 'main-agent' || team.mode === 'subagents')
    ? (team.mode as string)
    : teamModeForLevel(level);
  // Name the concrete cheapest model so the agent passes it on the quick-fix spawn
  // without resolving an indirection (haiku on Claude/Cursor, gpt-5.4-mini on Codex).
  const cheapest = resolveModel('cheapest', host) || 'the cheapest model for this host';
  const signals = hint.signals.length ? ` — signals: ${hint.signals.join(', ')}` : '';
  if (teamMode === 'subagents') beginFreshMaintenanceRun(cwd, state);
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  const ocActive = openCodeDelegationActive(state);
  // Render the OpenCode instruction only when delegation is actually active, so an
  // off state doesn't leave a dead-branch clause a literal reader must evaluate.
  let openCodeClause = '';
  let quickFixOpenCodeClause = '';
  let smallOpenCodeClause = '';
  if (ocActive) {
    if (teamMode === 'main-agent') {
      openCodeClause = ` If you prefer, offload it via the \`opencode_delegate\` tool (role "quick-fix").`;
    } else {
      quickFixOpenCodeClause = ` OpenCode is active — call the \`opencode_delegate\` tool FIRST with role "quick-fix", runId "${runId}", projectRoot, the bounded task; only if it declines, spawn the paid worker. If the host safety reviewer rejects the call but offers a user-approval path, ask the user once (it sends the task + relevant code to OpenCode's hosted model) and on approval re-call; otherwise use the paid fallback. If the tool is not exposed, say the opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback.`;
      smallOpenCodeClause = ` OpenCode is active — call the \`opencode_delegate\` tool FIRST with the chosen role "senior-frontend" or "senior-backend", runId "${runId}", projectRoot, the bounded task; only if it declines, spawn the paid role subagent. If the host safety reviewer rejects the call but offers a user-approval path, ask the user once (it sends the task + relevant code to OpenCode's hosted model) and on approval re-call; otherwise use the paid fallback. If the tool is not exposed, say the opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback.`;
    }
  }
  // The rubric is ~95% static prose: inject it in full once per session, then a
  // one-line reminder with the per-prompt variables (tier hint + fresh runId).
  // beginFreshMaintenanceRun above still runs on every triage prompt.
  if (!firstEmitThisSession(cwd, 'maintenance-triage', hookSessionIdentity(raw).sessionId)) {
    const ocReminder = ocActive && teamMode === 'subagents'
      ? ` OpenCode runId for \`opencode_delegate\`: "${runId}".`
      : '';
    return `[MAINTENANCE PHASE — triage reminder] hint: ${hint.tier} (confidence ${hint.confidence})${signals} — route per the maintenance-triage rubric from earlier in this session (full rubric: \`task-triage\` skill).${ocReminder}`;
  }
  const blockName = teamMode === 'main-agent' ? 'maintenance-triage-main-agent' : 'maintenance-triage-subagents';
  return `${block(blockName, {
    HINT: hint.tier,
    CONFIDENCE: hint.confidence,
    SIGNALS: signals,
    CHEAPEST_MODEL: cheapest,
    OPENCODE_CLAUSE: openCodeClause,
    QUICK_FIX_OPENCODE_CLAUSE: quickFixOpenCodeClause,
    SMALL_OPENCODE_CLAUSE: smallOpenCodeClause,
  })}`;
}
